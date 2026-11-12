import { unixSeconds } from '@sidequest/domain/Authority'
import { DateTime, Duration, Effect, Option } from 'effect'
import type { HttpServerRequest } from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { randomHex } from '../SignIn/Sessions.ts'
import { ClientDocuments, type KnownClient, publishedClient } from './ClientDocuments.ts'
import { bindingCookieName, consentPath, resourceOf } from './Endpoints.ts'
import { ConnectRequests, OAuthClients } from './OAuthStore.ts'
import { matchesRedirect, withResponse } from './RedirectUris.ts'
import { challengePattern, hashOf, requestSeconds, singleValued } from './Secrets.ts'

/** The longest `state` carried back to the client. */
const maxStateLength = 1024

/**
 * An authorization request that cannot be sent back to its client, because the client or the redirect is not one it
 * registered: shown to the person, never redirected (RFC 6749 §4.1.2.1), or this endpoint would be an open redirect.
 */
const notSentBack = (reason: string) =>
  HttpServerResponse.text(
    `This connection request is not valid: ${reason} Start again from the app you are connecting.`,
    {
      status: 400,
      headers: { 'cache-control': 'no-store' },
    },
  )

/** The client a `client_id` names: a metadata document's URL, or a client that registered itself here. */
const clientOf = Effect.fnUntraced(function* (
  clients: OAuthClients['Service'],
  documents: ClientDocuments['Service'],
  id: string | undefined,
) {
  if (id === undefined) return Option.none<KnownClient>()
  return id.startsWith('https://') ? yield* publishedClient(documents, id) : yield* clients.find(id)
})

/** Why an authorization request a client may be answered at cannot be granted, as an OAuth error; or nothing. */
const refusalOf = (
  query: Readonly<Record<string, string>>,
  origin: string,
): Option.Option<readonly [string, string]> => {
  if (query['response_type'] !== 'code')
    return Option.some(['unsupported_response_type', 'Only the code flow is served.'])
  if (query['code_challenge_method'] !== 'S256' || !challengePattern.test(query['code_challenge'] ?? ''))
    return Option.some(['invalid_request', 'PKCE with code_challenge_method=S256 is required.'])
  if (query['resource'] !== undefined && query['resource'] !== resourceOf(origin))
    return Option.some(['invalid_target', `The only resource is ${resourceOf(origin)}.`])
  if ((query['state'] ?? '').length > maxStateLength) return Option.some(['invalid_request', 'The state is too long.'])
  // Consent is never silent: a client that asks for no interaction is told it needs it.
  if (query['prompt'] === 'none') return Option.some(['consent_required', 'The person must consent on Sidequest.'])
  return Option.none()
}

/**
 * The authorization endpoint (OAuth 2.1 §4.1.1). It checks the client and its redirect first: a client it does not
 * know, or a redirect that is not exactly one the client registered (a loopback one at any port), is answered here and
 * never redirected. Every other refusal goes back to the client with its `state` and this issuer's `iss` (RFC 9207, so
 * a client talking to several servers cannot be mixed up). A valid request (code flow, PKCE S256, this site's `/mcp` as
 * the resource) waits for consent, bound to this browser by a cookie, and the browser goes to the website's consent
 * page, where the signed-in person decides.
 */
export const authorizeHandler = Effect.gen(function* () {
  const clients = yield* OAuthClients
  const documents = yield* ClientDocuments
  const requests = yield* ConnectRequests
  return Effect.fn('Sidequest.OAuth.authorize')(
    function* (request: HttpServerRequest) {
      const url = new URL(request.originalUrl)
      const query = singleValued(url.searchParams)
      if (query === undefined) return notSentBack('a parameter is repeated.')
      const client = yield* clientOf(clients, documents, query['client_id'])
      if (Option.isNone(client)) return notSentBack('the app is not known here.')
      const redirect = query['redirect_uri']
      if (redirect === undefined || !matchesRedirect(client.value.redirectUris, redirect))
        return notSentBack('the app named a redirect it did not register.')
      const answer = (parameters: Readonly<Record<string, string | null>>) =>
        HttpServerResponse.redirect(
          withResponse(redirect, { ...parameters, state: query['state'] ?? null, iss: url.origin }),
          {
            headers: { 'cache-control': 'no-store' },
          },
        )
      const refused = refusalOf(query, url.origin)
      if (Option.isSome(refused)) {
        const [error, description] = refused.value
        return answer({ error, error_description: description })
      }
      const now = unixSeconds(yield* DateTime.now)
      const binding = yield* randomHex(32)
      const id = yield* requests.open(
        {
          bindingHash: yield* hashOf(binding),
          clientId: client.value.id,
          clientName: client.value.name,
          clientKind: client.value.kind,
          redirectUri: redirect,
          state: query['state'] ?? null,
          codeChallenge: query['code_challenge'] ?? '',
          resource: resourceOf(url.origin),
          expiresAt: now + requestSeconds,
        },
        now,
      )
      const toConsent = HttpServerResponse.redirect(consentPath(id), { headers: { 'cache-control': 'no-store' } })
      return yield* HttpServerResponse.setCookie(toConsent, bindingCookieName, binding, {
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'lax',
        maxAge: Duration.seconds(requestSeconds),
      }).pipe(Effect.orDie)
    },
    Effect.catchTag('Unavailable', () => Effect.succeed(HttpServerResponse.empty({ status: 503 }))),
  )
})
