import type { UnixSeconds } from '@sidequest/protocol'
import { authorizeHandler, nowSeconds } from '@sidequest/serving/Authorize'
import { authorizePath, registerPath, resourceOf, revokePath, tokenPath } from '@sidequest/serving/Endpoints'
import { ConnectRequests, OAuthClients } from '@sidequest/serving/OAuthRequests'
import { addMetadataRoutes, formOf, invalidGrant, originOf, registerHandler } from '@sidequest/serving/OAuthServer'
import {
  accessSeconds,
  codePattern,
  corsHeaders,
  hashOf,
  oauthError,
  oauthJson,
  randomHex,
  refreshPattern,
  refreshSeconds,
  s256,
  verifierPattern,
} from '@sidequest/serving/Secrets'
import { Effect, Layer, Option, Predicate } from 'effect'
import * as HttpRouter from 'effect/http/HttpRouter'
import type { HttpServerRequest } from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { AgentKeys } from '../Keys/AgentKeys.ts'
import { bindingCookieName, consentPathOf } from './ConsentRoutes.ts'
import { type Connection, Connections } from './Connections.ts'

// OAuth 2.1 for MCP clients, the gateway's own issuer: the same account-free metadata, registration and authorization
// as the core (`@sidequest/serving`), with the gateway's consent page, where an operator proves their key and picks
// one of their agents. A connection is bound to that one agent. Codes, access and refresh tokens are opaque random
// strings stored as SHA-256 only; codes are single-use and live a minute, refresh tokens rotate and a reused one ends
// the connection, and tokens are bound to this origin's `/mcp`. Every token is issued only while the agent still
// exists under the operator who consented; whether it may act is the grant gate's question on every tool call.

/** An access token: `sqga_` and 32 random bytes in hex. */
export const accessPattern = /^sqga_[0-9a-f]{64}$/u

type Form = Readonly<Record<string, string>>

/** Whether a redeemed connection is the one this request may use: its client, its resource on this origin. */
const belongs = (connection: Connection, form: Form, origin: string) =>
  connection.clientId === form['client_id'] &&
  connection.resource === resourceOf(origin) &&
  (form['resource'] ?? connection.resource) === connection.resource

/** A fresh access and refresh token for `connection`, if its agent still exists under its operator. */
const tokensFor = Effect.fnUntraced(function* (connection: Connection, now: UnixSeconds) {
  const connections = yield* Connections
  const keys = yield* AgentKeys
  const agent = yield* keys.find(connection.agent)
  if (Option.isNone(agent) || agent.value.operator !== connection.operator) {
    yield* connections.revoke(connection.id, now)
    return invalidGrant
  }
  const access = `sqga_${yield* randomHex(32)}`
  const refresh = `sqr_${yield* randomHex(32)}`
  const accessHash = yield* hashOf(access)
  const refreshHash = yield* hashOf(refresh)
  const keptAccess = yield* connections.store(
    connection.id,
    { hash: accessHash, kind: 'access', expiresAt: now + accessSeconds },
    now,
  )
  const keptRefresh = yield* connections.store(
    connection.id,
    { hash: refreshHash, kind: 'refresh', expiresAt: now + refreshSeconds },
    now,
  )
  if (!keptAccess || !keptRefresh) return invalidGrant
  return oauthJson({ access_token: access, token_type: 'Bearer', expires_in: accessSeconds, refresh_token: refresh })
})

const tokenHandler = Effect.gen(function* () {
  const connections = yield* Connections
  const services = yield* Effect.context<Connections | AgentKeys>()

  const exchangeCode = Effect.fnUntraced(function* (form: Form, origin: string, now: UnixSeconds) {
    const code = form['code'] ?? ''
    const verifier = form['code_verifier'] ?? ''
    if (form['redirect_uri'] === undefined || form['client_id'] === undefined)
      return oauthError('invalid_request', 'code, code_verifier, redirect_uri and client_id are required.')
    if (!codePattern.test(code) || !verifierPattern.test(verifier)) return invalidGrant
    const redeemed = yield* connections.redeemCode(yield* hashOf(code), now)
    if (!Predicate.isTagged(redeemed, 'Found')) return invalidGrant
    const { connection } = redeemed
    const challenged = (yield* s256(verifier)) === connection.codeChallenge
    if (
      !challenged ||
      connection.codeExpiresAt <= now ||
      connection.redirectUri !== form['redirect_uri'] ||
      !belongs(connection, form, origin)
    ) {
      // A code that did not fit is spent all the same, and its connection never gets a token.
      yield* connections.revoke(connection.id, now)
      return invalidGrant
    }
    return yield* Effect.provideContext(tokensFor(connection, now), services)
  })

  const exchangeRefresh = Effect.fnUntraced(function* (form: Form, origin: string, now: UnixSeconds) {
    const token = form['refresh_token'] ?? ''
    if (form['client_id'] === undefined)
      return oauthError('invalid_request', 'refresh_token and client_id are required.')
    if (!refreshPattern.test(token)) return invalidGrant
    const redeemed = yield* connections.redeemRefresh(yield* hashOf(token), now)
    if (!Predicate.isTagged(redeemed, 'Found')) return invalidGrant
    if (!belongs(redeemed.connection, form, origin)) {
      yield* connections.revoke(redeemed.connection.id, now)
      return invalidGrant
    }
    return yield* Effect.provideContext(tokensFor(redeemed.connection, now), services)
  })

  return Effect.fn('Sidequest.Gateway.OAuth.token')(
    function* (request: HttpServerRequest) {
      const form = yield* formOf(request)
      if (form === undefined)
        return oauthError('invalid_request', 'Send each parameter once, as application/x-www-form-urlencoded.')
      const now = yield* nowSeconds
      const grant = form['grant_type']
      if (grant === 'authorization_code') return yield* exchangeCode(form, originOf(request), now)
      if (grant === 'refresh_token') return yield* exchangeRefresh(form, originOf(request), now)
      return oauthError('unsupported_grant_type', 'Only authorization_code and refresh_token are served.')
    },
    Effect.catchTag('Unavailable', () => Effect.succeed(oauthError('temporarily_unavailable', 'Try again.', 503))),
  )
})

/** RFC 7009: anyone holding a token may end it; the answer is 200 whatever the token was, so it tells nothing. */
const revokeHandler = Effect.gen(function* () {
  const connections = yield* Connections
  return Effect.fn('Sidequest.Gateway.OAuth.revoke')(
    function* (request: HttpServerRequest) {
      const form = yield* formOf(request)
      const token = form?.['token']
      if (token === undefined) return oauthError('invalid_request', 'token is required.')
      yield* connections.revokeToken(yield* hashOf(token), form?.['client_id'], yield* nowSeconds)
      return HttpServerResponse.empty({ status: 200, headers: corsHeaders })
    },
    Effect.catchTag('Unavailable', () => Effect.succeed(oauthError('temporarily_unavailable', 'Try again.', 503))),
  )
})

/** The gateway's OAuth endpoints. Needs the OAuth stores, the client document fetcher, connections and agents' keys. */
export const oauthRoutes = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter
    yield* addMetadataRoutes(router, 'Sidequest agent gateway')
    yield* router.add(
      'GET',
      authorizePath,
      yield* authorizeHandler({
        consentPath: consentPathOf,
        bindingCookieName,
        issuerName: 'the Sidequest agent gateway',
      }),
    )
    yield* router.add('POST', registerPath, yield* registerHandler)
    yield* router.add('POST', tokenPath, yield* tokenHandler)
    yield* router.add('POST', revokePath, yield* revokeHandler)
  }),
)

/** The account-free OAuth stores on the gateway's D1, and the fetcher of clients' metadata documents. */
export const OAuthStores = Layer.mergeAll(OAuthClients.layer, ConnectRequests.layer, Connections.layer)
