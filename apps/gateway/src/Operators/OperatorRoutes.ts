import { PublicKey } from '@sidequest/nostr'
import { nowSeconds } from '@sidequest/serving/Authorize'
import { ByteSize, Effect, Layer, Option, Schema } from 'effect'
import * as HttpIncomingMessage from 'effect/http/HttpIncomingMessage'
import * as HttpRouter from 'effect/http/HttpRouter'
import type { HttpServerRequest } from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import type { Unavailable } from '@sidequest/protocol'
import { AgentKeys, maxLabelLength, type TooManyAgents } from '../Keys/AgentKeys.ts'
import { OperatorAuth, type Unauthorized } from './Nip98.ts'

// The operator's API: an operator is a Nostr key, with no account and no session. Every request carries a NIP-98
// authorization (`Nip98.ts`) of exactly that request, so the website (or any client) on another origin calls it with
// the operator's signer; nothing ambient is read, so any origin may, and CORS allows them all. Creating an agent
// answers its public key, which the operator then names in a grant event they sign and publish through the core; the
// gateway lets the agent act only while that grant is active in the core's index. No endpoint ever answers a key.

const agentsPath = '/api/agents'

/** CORS for the operator's API: any origin, the NIP-98 header, no credentials. */
const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '600',
} as const

const reply = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: { ...cors, 'cache-control': 'no-store' } })
const refusal = (status: number, error: string, reason?: string) =>
  reply(reason === undefined ? { error } : { error, reason }, status)

const NewAgent = Schema.Struct({
  label: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(maxLabelLength)),
})
const decodeNewAgent = Schema.decodeUnknownOption(Schema.fromJsonString(NewAgent))
const decodeAgent = Schema.decodeUnknownOption(PublicKey)

/** The largest operator request read: a label. */
const maxBody = ByteSize.kibibytes(4)

/** A request's body as text, at most {@link maxBody}; empty when it has none. */
const bodyOf = (request: HttpServerRequest) =>
  Effect.option(request.text).pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, maxBody),
    Effect.map(Option.getOrElse(() => '')),
  )

/** Answers the operator API's failures: 401 for a missing or bad authorization, 503 when D1 does not answer. */
const answered = (
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, Unauthorized | Unavailable | TooManyAgents>,
) =>
  effect.pipe(
    Effect.catchTags({
      Unauthorized: (error: Unauthorized) => Effect.succeed(refusal(401, 'unauthorized', error.reason)),
      Unavailable: () => Effect.succeed(refusal(503, 'unavailable')),
      TooManyAgents: () => Effect.succeed(refusal(409, 'too_many_agents')),
    }),
  )

/**
 * `POST /api/agents` (`{ label }`) makes an agent and its key and answers `{ agent, operator, label, createdAt }`;
 * `GET /api/agents` lists the operator's agents; `DELETE /api/agents/:agent` destroys one and its key, and ends every
 * OAuth connection to it.
 */
export const operatorRoutes = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter
    const auth = yield* OperatorAuth
    const keys = yield* AgentKeys
    yield* router.add('OPTIONS', agentsPath, Effect.succeed(HttpServerResponse.empty({ status: 204, headers: cors })))
    yield* router.add(
      'OPTIONS',
      `${agentsPath}/:agent`,
      Effect.succeed(HttpServerResponse.empty({ status: 204, headers: cors })),
    )
    yield* router.add('POST', agentsPath, (request) =>
      Effect.gen(function* () {
        const body = yield* bodyOf(request)
        const operator = yield* auth.verify(request, body, true)
        const asked = decodeNewAgent(body)
        if (Option.isNone(asked))
          return refusal(400, 'invalid_request', 'Send JSON with a label of 1 to 120 characters.')
        return reply(yield* keys.create(operator, asked.value.label, yield* nowSeconds), 201)
      }).pipe(answered),
    )
    yield* router.add('GET', agentsPath, (request) =>
      Effect.gen(function* () {
        const operator = yield* auth.verify(request, '', false)
        return reply({ items: yield* keys.list(operator) })
      }).pipe(answered),
    )
    yield* router.add('DELETE', `${agentsPath}/:agent`, (request) =>
      Effect.gen(function* () {
        const operator = yield* auth.verify(request, '', true)
        const agent = decodeAgent(new URL(request.originalUrl).pathname.slice(agentsPath.length + 1))
        if (Option.isNone(agent)) return refusal(404, 'unknown_agent')
        const removed = yield* keys.remove(operator, agent.value, yield* nowSeconds)
        return removed ? HttpServerResponse.empty({ status: 204, headers: cors }) : refusal(404, 'unknown_agent')
      }).pipe(answered),
    )
  }),
)
