import * as HttpRouter from 'effect/http/HttpRouter'
import { Effect, Layer } from 'effect'
import { authorizeHandler } from '@sidequest/serving/Authorize'
import { authorizePath, registerPath, revokePath, tokenPath } from '@sidequest/serving/Endpoints'
import { addMetadataRoutes, registerHandler } from '@sidequest/serving/OAuthServer'
import { bindingCookieName, consentPath } from './Endpoints.ts'
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

/**
 * OAuth's own endpoints on the API Worker, outside the typed HTTP API: they speak OAuth's forms, redirects and errors,
 * and the token, registration and revocation endpoints are called by clients that are not this site's pages. The
 * metadata, registration and authorization are the account-free ones in `@sidequest/serving`, with the website's
 * consent page; the token endpoint and revocation are the core's, over its connections and agents' tokens. Needs the
 * OAuth stores, the client document fetcher, agents' tokens and access.
 */
export const oauthRoutes = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter
    const authorize = yield* authorizeHandler({ consentPath, bindingCookieName, issuerName: 'Sidequest' })
    const register = yield* registerHandler
    const token = yield* tokenHandler
    const revoke = yield* revokeHandler
    yield* addMetadataRoutes(router, 'Sidequest')
    yield* router.add('GET', authorizePath, authorize)
    yield* router.add('POST', registerPath, register)
    yield* router.add('POST', tokenPath, token)
    yield* router.add('POST', revokePath, revoke)
  }),
)
