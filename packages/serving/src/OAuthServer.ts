import { ByteSize, Effect, Option, Schema } from 'effect'
import * as HttpIncomingMessage from 'effect/http/HttpIncomingMessage'
import type * as HttpRouter from 'effect/http/HttpRouter'
import type { HttpServerRequest } from 'effect/http/HttpServerRequest'
import { nowSeconds } from './Authorize.ts'
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
import { OAuthClients } from './OAuthRequests.ts'
import { isAcceptableRedirect } from './RedirectUris.ts'
import { oauthError, oauthJson, preflight, singleValued } from './Secrets.ts'

// The account-free half of an OAuth 2.1 authorization server for MCP clients, shared by the core and the agent gateway:
// the RFC 9728 and RFC 8414 metadata, dynamic client registration (RFC 7591) and the form a token or revocation
// request is read from. Each server adds its own authorization, consent, token and revocation handlers.

/** The largest registration read. */
const maxRegistrationBody = ByteSize.kibibytes(16)

/** RFC 9728: where this resource takes tokens from, and how. `name` is the resource's name for people. */
const protectedResource = (origin: string, name: string) => ({
  resource: resourceOf(origin),
  authorization_servers: [origin],
  bearer_methods_supported: ['header'],
  resource_name: name,
})

/**
 * RFC 8414: the origin is the issuer. Clients are public (no secret: `none`) and register themselves (RFC 7591) or are
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
export const registerHandler = Effect.gen(function* () {
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
      const now = yield* nowSeconds
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

/** The origin a request came to: the issuer and the resource are named by it. */
export const originOf = (request: HttpServerRequest) => new URL(request.originalUrl).origin

/**
 * Adds the metadata documents (the protected resource's at both forms, and the authorization server's) and the CORS
 * preflights of every endpoint browser-based MCP clients call from their own origin. `name` is the resource's name.
 */
export const addMetadataRoutes = (router: HttpRouter.HttpRouter, name: string) =>
  Effect.gen(function* () {
    for (const path of [protectedResourcePath, protectedResourceRootPath])
      yield* router.add('GET', path, (request) => Effect.succeed(oauthJson(protectedResource(originOf(request), name))))
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
  })

/** The largest token or revocation request read. */
const maxFormBody = ByteSize.kibibytes(16)

const isForm = (contentType: string | undefined) =>
  /^application\/x-www-form-urlencoded\s*(?:;|$)/iu.test(contentType ?? '')

/** A token or revocation request's parameters: a form, each parameter once (RFC 6749 §3.2). */
export const formOf = (request: HttpServerRequest) =>
  Effect.gen(function* () {
    if (!isForm(request.headers['content-type'])) return undefined
    const text = yield* Effect.option(request.text)
    return Option.match(text, {
      onNone: () => undefined,
      onSome: (body) => singleValued(new URLSearchParams(body)),
    })
  }).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, maxFormBody))

/** The one refusal of every grant that is unknown, used, expired, revoked or another client's, so none is told apart. */
export const invalidGrant = oauthError(
  'invalid_grant',
  'The grant is unknown, used, expired, revoked or not this client’s.',
)
