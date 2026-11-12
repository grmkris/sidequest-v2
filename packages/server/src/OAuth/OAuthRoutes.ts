import { unixSeconds } from '@sidequest/domain/Authority'
import { ByteSize, DateTime, Effect, Layer, Option, Schema } from 'effect'
import * as HttpIncomingMessage from 'effect/http/HttpIncomingMessage'
import * as HttpRouter from 'effect/http/HttpRouter'
import type { HttpServerRequest } from 'effect/http/HttpServerRequest'
import { authorizeHandler } from './Authorize.ts'
import { clientName } from './ClientDocuments.ts'
import {
  authorizationServerPath,
  authorizePath,
  protectedResourcePath,
  protectedResourceRootPath,
  registerPath,
  resourceOf,
  revokePath,
  tokenPath,
} from './Endpoints.ts'
import { OAuthClients } from './OAuthStore.ts'
import { isAcceptableRedirect } from './RedirectUris.ts'
import { oauthError, oauthJson, preflight } from './Secrets.ts'
import { revokeHandler, tokenHandler } from './TokenEndpoint.ts'

// OAuth 2.1 for MCP clients, as the MCP authorization specification (2025-06-18, 2025-11-25, 2026-07-28) asks of an
// authorization server and protected resource. Threats, and what answers each:
//
// - Open redirect: the authorization endpoint redirects only to a URI the client registered, compared exactly (a
//   loopback one at any port, RFC 8252); a bad client or redirect is shown, never redirected to (`Authorize.ts`).
// - Code injection and replay: a code is single-use (one guarded UPDATE), lives a minute, and is redeemed only by its
//   client, at its redirect, with the PKCE S256 verifier of its challenge (PKCE is required; `plain` is refused). A
//   used code presented again revokes its connection and every token issued from it.
// - Mix-up: the authorization response carries `iss` (RFC 9207), advertised in the metadata; tokens are bound to this
//   origin's `/mcp` (RFC 8707) and refused anywhere else, the HTTP API included (`AgentAccess.admit`).
// - Token leakage: codes, refresh tokens and access tokens are stored as SHA-256 only; secrets travel in `Redacted`
//   until the one response that carries them, which no cache may keep; query strings are redacted from Workers logs;
//   the consent page's URL carries a request id, never a code, and the site's referrer policy sends only the origin.
// - Client impersonation through registration: a self-registered client's name proves nothing, so the consent page
//   says so and shows where the access goes (the redirect host, flagged when it is this device); a metadata-document
//   client is shown with the host that publishes it. Consent is never silent (`prompt=none` is refused), it needs the
//   signed-in person, and it is bound to the browser that opened the request.
// - Consent forgery and clickjacking: the consent API is same-origin JSON behind the session (`SameOrigin`), and every
//   page and answer forbids framing (`frame-ancestors 'none'` at the edge).
// - Refresh token theft: refresh tokens rotate on every use; a used one presented again revokes the whole connection.
// - Lost control: the person lists and revokes connections; revoking ends every token at once, and a revoked agent or
//   an expired grant is refused on every request regardless of the token.

/** The largest registration read. */
const maxRegistrationBody = ByteSize.kibibytes(16)

/** RFC 9728: where this resource takes tokens from, and how. */
const protectedResource = (origin: string) => ({
  resource: resourceOf(origin),
  authorization_servers: [origin],
  bearer_methods_supported: ['header'],
  resource_name: 'Sidequest',
})

/**
 * RFC 8414: this origin is the issuer. Clients are public (no secret: `none`) and register themselves (RFC 7591) or are
 * known by their metadata document (CIMD). No scopes are named: what a client may do is the grant of the agent the
 * person picks, judged on every request.
 */
const authorizationServer = (origin: string) => ({
  issuer: origin,
  authorization_endpoint: `${origin}${authorizePath}`,
  token_endpoint: `${origin}${tokenPath}`,
  registration_endpoint: `${origin}${registerPath}`,
  revocation_endpoint: `${origin}${revokePath}`,
  response_types_supported: ['code'],
  response_modes_supported: ['query'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
  revocation_endpoint_auth_methods_supported: ['none'],
  client_id_metadata_document_supported: true,
  authorization_response_iss_parameter_supported: true,
})

const Registration = Schema.Struct({
  redirect_uris: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(10)),
  client_name: Schema.optional(Schema.String),
  grant_types: Schema.optional(Schema.Array(Schema.String)),
  response_types: Schema.optional(Schema.Array(Schema.String)),
})
const decodeRegistration = Schema.decodeUnknownOption(Schema.fromJsonString(Registration))

/**
 * Dynamic client registration (RFC 7591), open to anyone, as MCP clients need. Every client is registered public (no
 * secret, whatever it asked for, which the answer states), for the code flow with refresh, with the redirects it named
 * if each is one this server accepts. Its name is kept as its own claim.
 */
const registerHandler = Effect.gen(function* () {
  const clients = yield* OAuthClients
  return Effect.fn('Sidequest.OAuth.register')(
    function* (request: HttpServerRequest) {
      const body = yield* Effect.option(request.text).pipe(
        Effect.provideService(HttpIncomingMessage.MaxBodySize, maxRegistrationBody),
      )
      const registration = Option.flatMap(body, decodeRegistration)
      if (Option.isNone(registration))
        return oauthError('invalid_client_metadata', 'Send JSON with one to ten redirect_uris.')
      const { redirect_uris: redirectUris, client_name, grant_types, response_types } = registration.value
      if (!redirectUris.every(isAcceptableRedirect))
        return oauthError(
          'invalid_redirect_uri',
          'Redirects must be https, http to a loopback address, or an app scheme.',
        )
      if (grant_types !== undefined && !grant_types.includes('authorization_code'))
        return oauthError('invalid_client_metadata', 'The authorization_code grant is the only flow served.')
      if (response_types !== undefined && !response_types.includes('code'))
        return oauthError('invalid_client_metadata', 'The code response type is the only one served.')
      const now = unixSeconds(yield* DateTime.now)
      const name = clientName(client_name)
      const id = yield* clients.register({ name, redirectUris }, now)
      return oauthJson(
        {
          client_id: id,
          client_id_issued_at: now,
          ...(name === null ? {} : { client_name: name }),
          redirect_uris: redirectUris,
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        },
        201,
      )
    },
    Effect.catchTag('Unavailable', () => Effect.succeed(oauthError('temporarily_unavailable', 'Try again.', 503))),
  )
})

const originOf = (request: HttpServerRequest) => new URL(request.originalUrl).origin

/**
 * OAuth's own endpoints on the API Worker, outside the typed HTTP API: they speak OAuth's forms, redirects and errors,
 * and the token, registration and revocation endpoints are called by clients that are not this site's pages. Needs
 * the OAuth stores, the client document fetcher, agents' tokens and access.
 */
export const oauthRoutes = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter
    const authorize = yield* authorizeHandler
    const register = yield* registerHandler
    const token = yield* tokenHandler
    const revoke = yield* revokeHandler
    for (const path of [protectedResourcePath, protectedResourceRootPath])
      yield* router.add('GET', path, (request) => Effect.succeed(oauthJson(protectedResource(originOf(request)))))
    yield* router.add('GET', authorizationServerPath, (request) =>
      Effect.succeed(oauthJson(authorizationServer(originOf(request)))),
    )
    for (const path of [
      protectedResourcePath,
      protectedResourceRootPath,
      authorizationServerPath,
      registerPath,
      tokenPath,
      revokePath,
    ])
      yield* router.add('OPTIONS', path, Effect.succeed(preflight))
    yield* router.add('GET', authorizePath, authorize)
    yield* router.add('POST', registerPath, register)
    yield* router.add('POST', tokenPath, token)
    yield* router.add('POST', revokePath, revoke)
  }),
)
