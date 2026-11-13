import { EventId, PublicKey } from '@sidequest/nostr'
import { nowSeconds } from '@sidequest/serving/Authorize'
import { ByteSize, Effect, Layer, Option, Schema } from 'effect'
import * as HttpIncomingMessage from 'effect/http/HttpIncomingMessage'
import * as HttpRouter from 'effect/http/HttpRouter'
import type { HttpServerRequest } from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { type Unavailable, WalletSignature } from '@sidequest/protocol'
import { delegateOf, Delegations } from '../Delegations/Delegations.ts'
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

/** The largest operator request read: a delegation, whose contract wallet's signature may run to a few kilobytes. */
const maxBody = ByteSize.kibibytes(16)

/** A request's body as text, at most {@link maxBody}; empty when it has none. */
const bodyOf = (request: HttpServerRequest) =>
  Effect.option(request.text).pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, maxBody),
    Effect.map(Option.getOrElse(() => '')),
  )

/**
 * A delivery delegation for one job: the operator's wallet signature of `DeliveryDelegate` (as the core's
 * `GET /api/index/jobs/:job/delivery-delegation?delegate=…&expiry=…` serves it, for the agent's `delegate`) and its
 * expiry, which must lie ahead.
 */
const NewDelegation = Schema.Struct({
  job: EventId,
  signature: WalletSignature,
  expiry: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 ** 48 - 1 })),
})
const decodeNewDelegation = Schema.decodeUnknownOption(Schema.fromJsonString(NewDelegation))
const decodeJob = Schema.decodeUnknownOption(EventId)

/** `/api/agents/:agent/delegations[/:job]`, its agent and job as written. */
const delegationsPath = /^\/api\/agents\/([^/]+)\/delegations(?:\/([^/]+))?$/u
const delegationPathOf = (request: HttpServerRequest) => {
  const [, agent, job] = delegationsPath.exec(new URL(request.originalUrl).pathname) ?? []
  return { agent: decodeAgent(agent), job: decodeJob(job) }
}

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
 *
 * Delivery delegations, for the operator's own agent only: `GET /api/agents/:agent/delegations` answers the agent's
 * `delegate` (the EVM address its wallet names in `DeliveryDelegate`); `POST /api/agents/:agent/delegations`
 * (`{ job, signature, expiry }`) stores the wallet's signature and expiry for one job, after which the agent's
 * `deliver` records that job's delivery on chain unattended; `DELETE /api/agents/:agent/delegations/:job` forgets it
 * (on chain, `revokeDeliveryDelegate` is what ends it for sure).
 */
export const operatorRoutes = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter
    const auth = yield* OperatorAuth
    const keys = yield* AgentKeys
    const delegations = yield* Delegations
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
    const preflight = Effect.succeed(HttpServerResponse.empty({ status: 204, headers: cors }))
    yield* router.add('OPTIONS', `${agentsPath}/:agent/delegations`, preflight)
    yield* router.add('OPTIONS', `${agentsPath}/:agent/delegations/:job`, preflight)
    /** The operator's own agent named in the path, or nothing. */
    const ownAgent = Effect.fnUntraced(function* (operator: PublicKey, request: HttpServerRequest) {
      const { agent } = delegationPathOf(request)
      if (Option.isNone(agent)) return Option.none<PublicKey>()
      const record = yield* keys.find(agent.value)
      return Option.flatMap(record, (found) => (found.operator === operator ? Option.some(found.agent) : Option.none()))
    })
    yield* router.add('GET', `${agentsPath}/:agent/delegations`, (request) =>
      Effect.gen(function* () {
        const operator = yield* auth.verify(request, '', false)
        const agent = yield* ownAgent(operator, request)
        if (Option.isNone(agent)) return refusal(404, 'unknown_agent')
        return reply({ agent: agent.value, delegate: Option.getOrNull(delegateOf(agent.value)) })
      }).pipe(answered),
    )
    yield* router.add('POST', `${agentsPath}/:agent/delegations`, (request) =>
      Effect.gen(function* () {
        const body = yield* bodyOf(request)
        const operator = yield* auth.verify(request, body, true)
        const agent = yield* ownAgent(operator, request)
        if (Option.isNone(agent)) return refusal(404, 'unknown_agent')
        const asked = decodeNewDelegation(body)
        const now = yield* nowSeconds
        if (Option.isNone(asked) || asked.value.expiry <= now)
          return refusal(400, 'invalid_request', 'Send JSON with a job id, the wallet signature and a future expiry.')
        const { job, signature, expiry } = asked.value
        yield* delegations.store(operator, agent.value, job, { signature, expiry }, now)
        return reply({ agent: agent.value, job, delegate: Option.getOrNull(delegateOf(agent.value)), expiry }, 201)
      }).pipe(answered),
    )
    yield* router.add('DELETE', `${agentsPath}/:agent/delegations/:job`, (request) =>
      Effect.gen(function* () {
        const operator = yield* auth.verify(request, '', true)
        const agent = yield* ownAgent(operator, request)
        const { job } = delegationPathOf(request)
        if (Option.isNone(agent) || Option.isNone(job)) return refusal(404, 'unknown_delegation')
        const removed = yield* delegations.remove(agent.value, job.value)
        return removed ? HttpServerResponse.empty({ status: 204, headers: cors }) : refusal(404, 'unknown_delegation')
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
