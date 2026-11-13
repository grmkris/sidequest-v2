import { PublicKey } from '@sidequest/nostr'
import type { Unavailable } from '@sidequest/protocol'
import { nowSeconds } from '@sidequest/serving/Authorize'
import { Effect, Layer, Option, Schema } from 'effect'
import * as HttpRouter from 'effect/http/HttpRouter'
import type { HttpServerRequest } from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { AgentKeys } from '../Keys/AgentKeys.ts'
import { AgentRoomState } from '../Rooms/AgentRoomState.ts'
import { OperatorAuth, type Unauthorized } from './Nip98.ts'
import { cors, reply } from './OperatorRoutes.ts'

// The operator's pause switch for one agent's rooms (ADR-0003: pausing agents is gateway behaviour). While paused, the
// agent's room tools refuse with `Paused`; its other tools are its grant's business. Like the rest of the operator's
// API, every request carries a NIP-98 authorization of exactly it, spent once used.

const pausePath = '/api/agents/:agent/pause'

const decodeAgent = Schema.decodeUnknownOption(PublicKey)

/** The agent a pause path names: `/api/agents/<agent>/pause`. */
const agentIn = (request: HttpServerRequest) => decodeAgent(new URL(request.originalUrl).pathname.split('/')[3] ?? '')

const answered = (effect: Effect.Effect<HttpServerResponse.HttpServerResponse, Unauthorized | Unavailable>) =>
  effect.pipe(
    Effect.catchTags({
      Unauthorized: (error: Unauthorized) =>
        Effect.succeed(reply({ error: 'unauthorized', reason: error.reason }, 401)),
      Unavailable: () => Effect.succeed(reply({ error: 'unavailable' }, 503)),
    }),
  )

/**
 * `GET /api/agents/:agent/pause` answers `{ agent, paused }`; `POST` pauses the agent's rooms and `DELETE` resumes
 * them, each answering the same. Only the agent's own operator may; anyone else gets 404, as for an unknown agent.
 */
export const pauseRoutes = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter
    const auth = yield* OperatorAuth
    const keys = yield* AgentKeys
    const state = yield* AgentRoomState
    const handle = (method: 'GET' | 'POST' | 'DELETE') => (request: HttpServerRequest) =>
      Effect.gen(function* () {
        const operator = yield* auth.verify(request, '', method !== 'GET')
        const agent = agentIn(request)
        const record = Option.isSome(agent) ? yield* keys.find(agent.value) : Option.none()
        if (Option.isNone(agent) || Option.isNone(record) || record.value.operator !== operator) {
          return reply({ error: 'unknown_agent' }, 404)
        }
        if (method !== 'GET') yield* state.setPaused(agent.value, method === 'POST', yield* nowSeconds)
        return reply({ agent: agent.value, paused: yield* state.paused(agent.value) })
      }).pipe(answered)
    yield* router.add('OPTIONS', pausePath, Effect.succeed(HttpServerResponse.empty({ status: 204, headers: cors })))
    yield* router.add('GET', pausePath, handle('GET'))
    yield* router.add('POST', pausePath, handle('POST'))
    yield* router.add('DELETE', pausePath, handle('DELETE'))
  }),
)
