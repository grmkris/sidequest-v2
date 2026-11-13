import { unixSeconds } from '@sidequest/domain/Authority'
import {
  type ConnectClient,
  ConnectRequestGone,
  type ConnectRequestId,
  Forbidden,
  NotFound,
  SidequestApi,
  SignedInAccount,
} from '@sidequest/protocol'
import { DateTime, Effect, Option, Redacted } from 'effect'
import type { HttpServerRequest } from 'effect/http/HttpServerRequest'
import { HttpApiBuilder } from 'effect/http-api'
import { AgentAccess } from '../Agents/AgentAccess.ts'
import { ConnectRequests, type PendingRequest } from '@sidequest/serving/OAuthRequests'
import { redirectShown, withResponse } from '@sidequest/serving/RedirectUris'
import { codeSeconds, hashOf, newSecret } from '@sidequest/serving/Secrets'
import { bindingCookieName } from './Endpoints.ts'
import { type ConnectionRow, Connections } from './OAuthStore.ts'

const now = Effect.map(DateTime.now, unixSeconds)

/** A client as the person sees it: a metadata-document client with the host that publishes it. */
const clientShown = (row: Pick<PendingRequest, 'clientId' | 'clientName' | 'clientKind'>): ConnectClient => ({
  id: row.clientId,
  name: row.clientName,
  kind: row.clientKind,
  publisher: row.clientKind === 'published' ? new URL(row.clientId).host : null,
})

const connectionShown = (row: ConnectionRow) => ({
  id: row.id,
  agent: row.agent,
  client: clientShown(row),
  redirect: redirectShown(row.redirectUri),
  connectedAt: row.createdAt,
})

/** This authorization server's issuer identifier, sent back with every decision (RFC 9207). */
const issuer = (request: HttpServerRequest) => new URL(request.originalUrl).origin

/** The hash of the cookie binding a request to this browser, if the browser has one. */
const bindingOf = (request: HttpServerRequest) => {
  const cookie = request.cookies[bindingCookieName]
  return cookie === undefined ? Effect.succeed(Option.none<string>()) : Effect.map(hashOf(cookie), Option.some)
}

/**
 * The `connect` group: the consent page's API. The signed-in person reads an MCP client's authorization request
 * (only in the browser that opened it), allows it to act as one of their agents, which must be theirs, not revoked,
 * with a grant that has not ended, or refuses it; either decides the request once and answers where the browser goes
 * back to the client. They list their connected clients and revoke one, which ends every token it holds.
 */
export const connectHandlers = HttpApiBuilder.group(SidequestApi, 'connect', (handlers) =>
  Effect.gen(function* () {
    const requests = yield* ConnectRequests
    const connections = yield* Connections
    const access = yield* AgentAccess

    /** The request, if it still waits in this browser; else `ConnectRequestGone`. */
    const waiting = Effect.fnUntraced(function* (
      id: ConnectRequestId,
      request: HttpServerRequest,
      take: typeof requests.pending,
    ) {
      const binding = yield* bindingOf(request)
      const found = Option.isNone(binding) ? Option.none() : yield* take(id, binding.value, yield* now)
      return yield* Option.match(found, {
        onNone: () => Effect.fail(new ConnectRequestGone()),
        onSome: (pending) => Effect.succeed(pending),
      })
    })

    /** The agent the person picked: theirs, not revoked, with a grant that has not ended. */
    const pickable = Effect.fnUntraced(function* (agent: Parameters<typeof access.operated>[1]) {
      const state = yield* access.operated(yield* SignedInAccount, agent)
      if (state.revoked) return yield* new Forbidden({ reason: 'AgentRevoked', evidence: { agent } })
      if (state.grant === undefined || state.grant.expiresAt <= (yield* now))
        return yield* new Forbidden({ reason: 'GrantExpired', evidence: { agent } })
    })

    return handlers
      .handle('request', ({ params, request }) =>
        Effect.map(waiting(params.request, request, requests.pending), (pending) => ({
          id: pending.id,
          client: clientShown(pending),
          redirect: redirectShown(pending.redirectUri),
          resource: pending.resource,
          expiresAt: pending.expiresAt,
        })),
      )
      .handle('allow', ({ params, payload, request }) =>
        Effect.gen(function* () {
          yield* waiting(params.request, request, requests.pending)
          yield* pickable(payload.agent)
          const decided = yield* waiting(params.request, request, requests.decide)
          const code = yield* newSecret('sqc_')
          const at = yield* now
          const party = { account: yield* SignedInAccount, agent: payload.agent }
          yield* connections.connect(decided, party, { hash: yield* hashOf(code), expiresAt: at + codeSeconds }, at)
          const answer = { code: Redacted.value(code), state: decided.state, iss: issuer(request) }
          return { redirect: withResponse(decided.redirectUri, answer) }
        }),
      )
      .handle('refuse', ({ params, request }) =>
        Effect.map(waiting(params.request, request, requests.decide), (decided) => ({
          redirect: withResponse(decided.redirectUri, {
            error: 'access_denied',
            error_description: 'The person did not allow the connection.',
            state: decided.state,
            iss: issuer(request),
          }),
        })),
      )
      .handle('connections', () =>
        Effect.gen(function* () {
          const rows = yield* connections.list(yield* SignedInAccount)
          return { items: rows.map(connectionShown) }
        }),
      )
      .handle('disconnect', ({ params }) =>
        Effect.gen(function* () {
          const owned = yield* connections.owned(yield* SignedInAccount, params.connection)
          // A connection is the family of a client's tokens: an unknown one is refused as an unknown token.
          if (Option.isNone(owned))
            return yield* new NotFound({ reason: 'UnknownToken', evidence: { connection: params.connection } })
          yield* connections.revoke(params.connection, yield* now)
        }),
      )
  }),
)
