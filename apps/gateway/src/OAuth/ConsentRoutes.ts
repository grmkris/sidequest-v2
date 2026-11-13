import { PublicKey } from '@sidequest/nostr'
import { ConnectRequestId, type GrantScope, type Unavailable } from '@sidequest/protocol'
import { nowSeconds } from '@sidequest/serving/Authorize'
import { ConnectRequests, type PendingRequest } from '@sidequest/serving/OAuthRequests'
import { withResponse } from '@sidequest/serving/RedirectUris'
import { codeSeconds, hashOf, newSecret, randomHex } from '@sidequest/serving/Secrets'
import { ByteSize, Effect, Layer, Option, Predicate, Redacted, Result, Schema } from 'effect'
import * as HttpIncomingMessage from 'effect/http/HttpIncomingMessage'
import * as HttpRouter from 'effect/http/HttpRouter'
import type { HttpServerRequest } from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import type { CoreError } from '../Core/Core.ts'
import { GrantGate } from '../Grants/GrantGate.ts'
import { AgentKeys } from '../Keys/AgentKeys.ts'
import { OperatorAuth, type Unauthorized } from '../Operators/Nip98.ts'
import { consentPage, consentPolicy, gonePage } from './ConsentPage.ts'
import { Connections } from './Connections.ts'

/** The gateway's consent page for an authorization request. */
export const consentPathOf = (request: string) => `/consent/${request}`

/** The cookie binding an authorization request to the browser that opened it (`__Host-`: this origin only). */
export const bindingCookieName = '__Host-sidequest-gateway-connect'

const uncached = { 'cache-control': 'no-store' } as const
const htmlType = 'text/html; charset=utf-8'
const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status, headers: uncached })
const decodeRequestId = Schema.decodeUnknownOption(ConnectRequestId)
const decodeOperator = Schema.decodeUnknownOption(PublicKey)
const decodeAllow = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ agent: PublicKey })))
const gone = () => json({ error: 'request_gone' }, 410)

/** The request id in `/consent/<id>[/...]`. */
const requestIdOf = (request: HttpServerRequest) =>
  decodeRequestId(new URL(request.originalUrl).pathname.split('/')[2] ?? '')

/** What a consent call may fail with, before it is answered. */
type ConsentFailure = Unauthorized | Unavailable | CoreError

/** A bad authorization answers 401; the gateway's store or the core not answering, 503. */
const answered = (effect: Effect.Effect<HttpServerResponse.HttpServerResponse, ConsentFailure>) =>
  effect.pipe(
    Effect.catch((error: ConsentFailure) =>
      Effect.succeed(
        Predicate.isTagged(error, 'Unauthorized')
          ? json({ error: 'unauthorized', reason: error.reason }, 401)
          : json({ error: 'temporarily_unavailable' }, 503),
      ),
    ),
  )

/** One of the operator's agents as the consent page lists it: one with an active grant, and that grant's scopes. */
interface Pickable {
  readonly agent: PublicKey
  readonly label: string
  readonly scopes: ReadonlyArray<GrantScope>
  readonly expiresAt: number
}

interface Services {
  readonly requests: ConnectRequests['Service']
  readonly connections: Connections['Service']
  readonly keys: AgentKeys['Service']
  readonly gate: GrantGate['Service']
  readonly auth: OperatorAuth['Service']
}

/** The request, if it still waits in this browser; `take` either reads it or decides it. */
const waiting = (request: HttpServerRequest, take: ConnectRequests['Service']['pending']) =>
  Effect.gen(function* () {
    const id = requestIdOf(request)
    const binding = request.cookies[bindingCookieName]
    if (Option.isNone(id) || binding === undefined) return Option.none<PendingRequest>()
    return yield* take(id.value, yield* hashOf(binding), yield* nowSeconds)
  })

/** The operator's agents that could act now, each with the grant the gate would admit. */
const pickable = ({ keys, gate }: Services, operator: PublicKey) =>
  Effect.gen(function* () {
    const admitted = yield* Effect.forEach(yield* keys.list(operator), (record) =>
      gate.admit(record.agent, operator, null).pipe(
        Effect.map(({ grant }): Option.Option<Pickable> =>
          Option.some({ agent: record.agent, label: record.label, scopes: grant.scopes, expiresAt: grant.expiresAt }),
        ),
        Effect.catchTag('GrantRefused', () => Effect.succeedNone),
      ),
    )
    return admitted.flatMap(Option.toArray)
  })

const page = ({ requests }: Services, request: HttpServerRequest) =>
  Effect.gen(function* () {
    const pending = yield* waiting(request, requests.pending)
    if (Option.isNone(pending))
      return HttpServerResponse.text(gonePage, { status: 400, headers: uncached, contentType: htmlType })
    const nonce = yield* randomHex(16)
    return HttpServerResponse.text(consentPage(pending.value, nonce), {
      contentType: htmlType,
      headers: { ...uncached, 'content-security-policy': consentPolicy(nonce), 'referrer-policy': 'no-referrer' },
    })
  })

const agents = (services: Services, request: HttpServerRequest) =>
  Effect.gen(function* () {
    const operator = decodeOperator(new URL(request.originalUrl).searchParams.get('operator'))
    if (Option.isNone(operator)) return json({ error: 'invalid_request' }, 400)
    if (Option.isNone(yield* waiting(request, services.requests.pending))) return gone()
    return json({ items: yield* pickable(services, operator.value) })
  })

/** Why the operator may not connect this agent: not theirs, or no active grant now; or nothing. */
const refusalToConnect = (services: Services, operator: PublicKey, agent: PublicKey) =>
  Effect.gen(function* () {
    const record = yield* services.keys.find(agent)
    if (Option.isNone(record) || record.value.operator !== operator)
      return Option.some(json({ error: 'not_your_agent', reason: 'The agent is not one you keep here.' }, 403))
    const admitted = yield* Effect.result(services.gate.admit(agent, operator, null))
    if (Result.isSuccess(admitted)) return Option.none()
    const reason = Predicate.isTagged(admitted.failure, 'GrantRefused') ? admitted.failure.reason : 'CoreUnavailable'
    return Option.some(json({ error: 'no_active_grant', reason }, 403))
  })

const allow = (services: Services, request: HttpServerRequest) =>
  Effect.gen(function* () {
    const read = yield* Effect.option(request.text).pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(1)),
    )
    const body = Option.getOrElse(read, () => '')
    const operator = yield* services.auth.verify(request, body, true)
    const asked = decodeAllow(body)
    if (Option.isNone(asked)) return json({ error: 'invalid_request' }, 400)
    if (Option.isNone(yield* waiting(request, services.requests.pending))) return gone()
    const refused = yield* refusalToConnect(services, operator, asked.value.agent)
    if (Option.isSome(refused)) return refused.value
    const decided = yield* waiting(request, services.requests.decide)
    if (Option.isNone(decided)) return gone()
    const code = yield* newSecret('sqc_')
    const now = yield* nowSeconds
    const party = { operator, agent: asked.value.agent }
    const issued = { hash: yield* hashOf(code), expiresAt: now + codeSeconds }
    yield* services.connections.open(decided.value, party, issued, now)
    const answer = { code: Redacted.value(code), state: decided.value.state, iss: new URL(request.originalUrl).origin }
    return json({ redirect: withResponse(decided.value.redirectUri, answer) })
  })

const refuse = ({ requests }: Services, request: HttpServerRequest) =>
  Effect.gen(function* () {
    const decided = yield* waiting(request, requests.decide)
    if (Option.isNone(decided)) return gone()
    return json({
      redirect: withResponse(decided.value.redirectUri, {
        error: 'access_denied',
        error_description: 'The operator did not allow the connection.',
        state: decided.value.state,
        iss: new URL(request.originalUrl).origin,
      }),
    })
  })

/**
 * The consent page and its three calls, all bound to the browser that opened the request (its binding cookie): the
 * agents an operator could pick, allowing one (with a NIP-98 authorization of exactly that request, so only the
 * operator's own signer can allow, and only an agent of theirs with an active grant), and refusing.
 */
export const consentRoutes = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter
    const services: Services = {
      requests: yield* ConnectRequests,
      connections: yield* Connections,
      keys: yield* AgentKeys,
      gate: yield* GrantGate,
      auth: yield* OperatorAuth,
    }
    yield* router.add('GET', '/consent/:request', (request) => answered(page(services, request)))
    yield* router.add('GET', '/consent/:request/agents', (request) => answered(agents(services, request)))
    yield* router.add('POST', '/consent/:request/allow', (request) => answered(allow(services, request)))
    yield* router.add('POST', '/consent/:request/refuse', (request) => answered(refuse(services, request)))
  }),
)
