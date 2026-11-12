import { unixSeconds } from '@sidequest/domain/Authority'
import type { UnixSeconds } from '@sidequest/protocol'
import { ByteSize, DateTime, Effect, Option, Predicate, Redacted } from 'effect'
import * as HttpIncomingMessage from 'effect/http/HttpIncomingMessage'
import type { HttpServerRequest } from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { AgentAccess } from '../Agents/AgentAccess.ts'
import { AgentTokens } from '../Agents/AgentTokens.ts'
import { resourceOf } from './Endpoints.ts'
import { type ConnectionRow, Connections } from './OAuthStore.ts'
import {
  accessSeconds,
  codePattern,
  corsHeaders,
  hashOf,
  newSecret,
  oauthError,
  oauthJson,
  refreshPattern,
  refreshSeconds,
  s256,
  singleValued,
  verifierPattern,
} from './Secrets.ts'

/** The largest token or revocation request read. */
const maxFormBody = ByteSize.kibibytes(16)

const isForm = (contentType: string | undefined) =>
  /^application\/x-www-form-urlencoded\s*(?:;|$)/iu.test(contentType ?? '')

/** A token or revocation request's parameters: a form, each parameter once (RFC 6749 §3.2). */
const formOf = (request: HttpServerRequest) =>
  Effect.gen(function* () {
    if (!isForm(request.headers['content-type'])) return undefined
    const text = yield* Effect.option(request.text)
    return Option.match(text, {
      onNone: () => undefined,
      onSome: (body) => singleValued(new URLSearchParams(body)),
    })
  }).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, maxFormBody))

const invalidGrant = oauthError('invalid_grant', 'The grant is unknown, used, expired, revoked or not this client’s.')

type Form = Readonly<Record<string, string>>

/**
 * The token endpoint (OAuth 2.1 §3.2) and revocation (RFC 7009) for public clients: a client proves itself by the PKCE
 * verifier of the code it was given, and by holding the refresh token issued to it, never by a secret, so no client
 * credential is read (one sent is ignored). Every token is issued for a standing connection whose agent its person
 * still operates, unrevoked.
 */
export const tokenHandler = Effect.gen(function* () {
  const connections = yield* Connections
  const tokens = yield* AgentTokens
  const access = yield* AgentAccess

  /** A new access token and refresh token for a connection, or `invalid_grant` if it or its agent is gone. */
  const issue = Effect.fnUntraced(function* (connection: ConnectionRow, now: UnixSeconds) {
    const agent = yield* Effect.option(access.operated(connection.account, connection.agent))
    if (Option.isNone(agent) || agent.value.revoked) return invalidGrant
    const accessToken = yield* tokens.issueForConnection(connection.id, accessSeconds, now)
    const refreshToken = yield* newSecret('sqr_')
    const refreshed = yield* connections.issueRefresh(connection.id, yield* hashOf(refreshToken), refreshSeconds, now)
    if (Option.isNone(accessToken) || !refreshed) return invalidGrant
    return oauthJson({
      access_token: Redacted.value(accessToken.value.token),
      token_type: 'Bearer',
      expires_in: accessSeconds,
      refresh_token: Redacted.value(refreshToken),
    })
  })

  /** A code for this client, redirect and resource, within its minute, whose challenge the verifier answers. */
  const byCode = Effect.fnUntraced(function* (form: Form, origin: string, now: UnixSeconds) {
    const { code, code_verifier: verifier, redirect_uri: redirect, client_id: client, resource } = form
    if (code === undefined || verifier === undefined || redirect === undefined || client === undefined)
      return oauthError('invalid_request', 'code, code_verifier, redirect_uri and client_id are required.')
    if (!codePattern.test(code) || !verifierPattern.test(verifier)) return invalidGrant
    const redeemed = yield* connections.redeemCode(yield* hashOf(code), now)
    if (!Predicate.isTagged(redeemed, 'Redeemed')) return invalidGrant
    const { connection } = redeemed
    const fits =
      connection.codeExpiresAt > now &&
      connection.clientId === client &&
      connection.redirectUri === redirect &&
      connection.resource === resourceOf(origin) &&
      (resource === undefined || resource === connection.resource) &&
      (yield* s256(verifier)) === connection.codeChallenge
    // The code is spent either way; a connection whose code did not fit never gets a token.
    if (!fits) {
      yield* connections.revoke(connection.id, now)
      return invalidGrant
    }
    return yield* issue(connection, now)
  })

  /** A refresh token used once, by the client it was issued to, for this site's `/mcp`; it is replaced. */
  const byRefresh = Effect.fnUntraced(function* (form: Form, origin: string, now: UnixSeconds) {
    const { refresh_token: token, client_id: client, resource } = form
    if (token === undefined || client === undefined)
      return oauthError('invalid_request', 'refresh_token and client_id are required.')
    if (!refreshPattern.test(token)) return invalidGrant
    const redeemed = yield* connections.redeemRefresh(yield* hashOf(token), now)
    if (!Predicate.isTagged(redeemed, 'Redeemed')) return invalidGrant
    const { connection } = redeemed
    const fits =
      connection.clientId === client &&
      connection.resource === resourceOf(origin) &&
      (resource === undefined || resource === connection.resource)
    if (!fits) {
      yield* connections.revoke(connection.id, now)
      return invalidGrant
    }
    return yield* issue(connection, now)
  })

  const token = Effect.fn('Sidequest.OAuth.token')(
    function* (request: HttpServerRequest) {
      const form = yield* formOf(request)
      if (form === undefined)
        return oauthError('invalid_request', 'Send each parameter once, as application/x-www-form-urlencoded.')
      const origin = new URL(request.originalUrl).origin
      const now = unixSeconds(yield* DateTime.now)
      if (form['grant_type'] === 'authorization_code') return yield* byCode(form, origin, now)
      if (form['grant_type'] === 'refresh_token') return yield* byRefresh(form, origin, now)
      return oauthError('unsupported_grant_type', 'Only authorization_code and refresh_token are served.')
    },
    Effect.catchTag('Unavailable', () => Effect.succeed(oauthError('temporarily_unavailable', 'Try again.', 503))),
  )

  return token
})

/**
 * Revocation (RFC 7009): a refresh token ends its whole connection, an access token only itself. Whoever holds a token
 * may end it; a token that names another client than the one given, or no token this server issued, changes nothing,
 * and the answer is the same 200 either way, so it tells nothing about tokens.
 */
export const revokeHandler = Effect.gen(function* () {
  const connections = yield* Connections
  return Effect.fn('Sidequest.OAuth.revoke')(
    function* (request: HttpServerRequest) {
      const form = yield* formOf(request)
      if (form?.['token'] === undefined) return oauthError('invalid_request', 'token is required.')
      const hash = yield* hashOf(form['token'])
      const owner = yield* connections.tokenOwner(hash)
      const client = form['client_id']
      if (Option.isSome(owner) && (client === undefined || client === owner.value.connection.clientId)) {
        const now = unixSeconds(yield* DateTime.now)
        if (owner.value.kind === 'refresh') yield* connections.revoke(owner.value.connection.id, now)
        else yield* connections.revokeAccess(hash, now)
      }
      return HttpServerResponse.empty({ status: 200, headers: corsHeaders })
    },
    Effect.catchTag('Unavailable', () => Effect.succeed(oauthError('temporarily_unavailable', 'Try again.', 503))),
  )
})
