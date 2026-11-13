import { webCrypto } from '@sidequest/protocol'
import { Clock, Crypto, type Duration, Effect, Option, Queue, Result, Schema, type Scope } from 'effect'
import type { EventTemplate, NostrEvent } from './Event.ts'
import type { SecretKey } from './Keys.ts'
import { standardKinds } from './Kinds.ts'
import { decodeFrame, type Filter, type OkReply, type RelayFrame } from './RelayFrames.ts'
import { signEvent } from './Sign.ts'

// A NIP-01 client over the standard `WebSocket`, which workerd, Bun, Node and browsers all provide: the index's poller
// and outbox, the agent gateway's rooms, and the website's rooms (through the edge's relay pipe) use the same one.

/**
 * Why talking to a relay failed: it could not be reached, it did not answer in time, it dropped the connection, it
 * sent a message larger than the client reads, it refused a subscription, or it refused our NIP-42 authentication.
 */
export class RelayFailure extends Schema.TaggedError<RelayFailure>()('RelayFailure', {
  relay: Schema.String,
  reason: Schema.Literals(['unreachable', 'timeout', 'dropped', 'oversize', 'refused', 'authFailed']),
}) {}

/** Signs a relay's NIP-42 authentication event: a key's own signer, or a browser extension's. */
export type AuthSigner = (template: EventTemplate) => Effect.Effect<NostrEvent, unknown>

/** The {@link AuthSigner} of a key this process holds. */
export const keyAuth =
  (key: SecretKey): AuthSigner =>
  (template) =>
    signEvent(template, key).pipe(Effect.provideService(Crypto.Crypto, webCrypto))

/** How one connection behaves: its timeouts, the largest message it reads, and who answers a relay's NIP-42
 * challenge, when anyone does. */
export interface ClientOptions {
  readonly connectTimeout: Duration.Duration
  readonly replyTimeout: Duration.Duration
  readonly maxFrameLength: number
  readonly auth: Option.Option<AuthSigner>
}

/** One open connection to a relay: publish an event, or read what a filter matches until the relay's `EOSE`. */
export interface RelayConnection {
  readonly url: string
  readonly publish: (event: NostrEvent) => Effect.Effect<OkReply, RelayFailure>
  readonly query: (filter: Filter) => Effect.Effect<ReadonlyArray<unknown>, RelayFailure>
}

/** What the socket hands the client: a text message, or the end of the connection and why. */
type Inbound = { readonly text: string } | { readonly ended: 'dropped' | 'oversize' }

/** The most events one subscription may bring before the client gives up on it: a relay that ignores `limit`. */
const maxEventsPerQuery = 10_000

/** The socket's events, onto the queue the client reads. A message over the size bound ends the connection. */
const listen = (socket: WebSocket, inbound: Queue.Queue<Inbound>, maxFrameLength: number) => {
  socket.addEventListener('message', (event: MessageEvent) => {
    const data: unknown = event.data
    // NIP-01 speaks text; a binary message is no frame of it, and is skipped.
    if (typeof data !== 'string') return
    if (data.length <= maxFrameLength) {
      Queue.offerUnsafe(inbound, { text: data })
      return
    }
    Queue.offerUnsafe(inbound, { ended: 'oversize' })
    socket.close()
  })
  const ended = () => void Queue.offerUnsafe(inbound, { ended: 'dropped' })
  socket.addEventListener('close', ended)
  socket.addEventListener('error', ended)
}

/** Waits for the socket to open; it closing or failing first means the relay was not reached. */
const opened = (socket: WebSocket, failure: RelayFailure) =>
  Effect.callback<void, RelayFailure>((resume) => {
    if (socket.readyState === WebSocket.OPEN) return resume(Effect.void)
    socket.addEventListener('open', () => resume(Effect.void))
    socket.addEventListener('close', () => resume(Effect.fail(failure)))
    socket.addEventListener('error', () => resume(Effect.fail(failure)))
  })

const closeQuietly = (socket: WebSocket) => Effect.ignore(Effect.try(() => socket.close()))

/** The client's side of one connection: frames read in order, sends, and the challenge the relay sent, if any. */
const sessionOf = (url: string, socket: WebSocket, inbound: Queue.Queue<Inbound>, options: ClientOptions) => {
  const state = { challenge: Option.none<string>(), subscriptions: 0 }
  const fail = (reason: RelayFailure['reason']) => new RelayFailure({ relay: url, reason })
  const timedOut = () => Effect.fail(fail('timeout'))
  const send = (message: ReadonlyArray<unknown>) =>
    Effect.try({ try: () => socket.send(JSON.stringify(message)), catch: () => fail('dropped') })
  const noted = (frame: Option.Option<RelayFrame>) => {
    if (Option.isSome(frame) && frame.value[0] === 'AUTH') state.challenge = Option.some(frame.value[1])
    return frame
  }
  /** The next frame the relay sent (none for a message that is no frame), or the connection's end. */
  const next = Effect.flatMap(Queue.take(inbound), (item) =>
    'text' in item ? Effect.succeed(noted(decodeFrame(item.text))) : Effect.fail(fail(item.ended)),
  )
  /** Reads frames until `pick` takes one, within the reply timeout. */
  const awaiting = <A>(pick: (frame: RelayFrame) => Option.Option<A>) =>
    Effect.gen(function* () {
      for (;;) {
        const picked = Option.flatMap(yield* next, pick)
        if (Option.isSome(picked)) return picked.value
      }
    }).pipe(Effect.timeoutOrElse({ duration: options.replyTimeout, orElse: timedOut }))
  return { state, fail, timedOut, send, next, awaiting }
}

type Session = ReturnType<typeof sessionOf>

const okFor =
  (id: string) =>
  (frame: RelayFrame): Option.Option<OkReply> =>
    frame[0] === 'OK' && frame[1] === id ? Option.some({ accepted: frame[2], message: frame[3] }) : Option.none()

const challengeIn = (frame: RelayFrame) => (frame[0] === 'AUTH' ? Option.some(frame[1]) : Option.none())

/** Answers the relay's NIP-42 challenge (waiting for one if none came yet) with an event the signer signs. */
const authenticate = Effect.fnUntraced(function* (url: string, session: Session, auth: AuthSigner) {
  const challenge = Option.isSome(session.state.challenge)
    ? session.state.challenge.value
    : yield* session.awaiting(challengeIn)
  const template = {
    created_at: Math.floor((yield* Clock.currentTimeMillis) / 1000),
    kind: standardKinds.clientAuth,
    tags: [
      ['relay', url],
      ['challenge', challenge],
    ],
    content: '',
  }
  const signed = yield* auth(template).pipe(Effect.mapError(() => session.fail('authFailed')))
  yield* session.send(['AUTH', signed])
  const reply = yield* session.awaiting(okFor(signed.id))
  if (!reply.accepted) return yield* session.fail('authFailed')
})

const authRequired = (message: string) => message.startsWith('auth-required:')

/** `EVENT` until its `OK`; refused for want of authentication, authenticates and sends it once more. */
const publishOn = (url: string, session: Session, options: ClientOptions) =>
  Effect.fnUntraced(function* (event: NostrEvent) {
    yield* session.send(['EVENT', event])
    const reply = yield* session.awaiting(okFor(event.id))
    if (reply.accepted || !authRequired(reply.message) || Option.isNone(options.auth)) return reply
    yield* authenticate(url, session, options.auth.value)
    yield* session.send(['EVENT', event])
    return yield* session.awaiting(okFor(event.id))
  })

/** What one frame means to subscription `id`: an event of it, its end, its refusal and why, or nothing. */
type Step =
  | { readonly event: unknown }
  | { readonly end: true }
  | { readonly closed: string }
  | { readonly other: true }

const stepOf = (id: string, frame: Option.Option<RelayFrame>): Step => {
  if (Option.isNone(frame) || frame.value[1] !== id) return { other: true }
  const value = frame.value
  if (value[0] === 'EVENT') return { event: value[2] }
  if (value[0] === 'EOSE') return { end: true }
  return value[0] === 'CLOSED' ? { closed: value[2] } : { other: true }
}

/** One subscription: its events until `EOSE`, or the relay's reason when it sends `CLOSED` instead. */
const subscribe = (session: Session, filter: Filter) =>
  Effect.gen(function* () {
    session.state.subscriptions += 1
    const id = `sq-${session.state.subscriptions}`
    yield* session.send(['REQ', id, filter])
    const events: Array<unknown> = []
    for (;;) {
      const step = stepOf(id, yield* session.next)
      if ('closed' in step) return Result.fail(step.closed)
      if ('end' in step) break
      if ('event' in step) events.push(step.event)
      if (events.length > maxEventsPerQuery) return yield* session.fail('oversize')
    }
    yield* Effect.ignore(session.send(['CLOSE', id]))
    return Result.succeed(events)
  })

/** `REQ` until `EOSE`, within the reply timeout: a relay that never ends the stored events fails, never truncates. */
const queryOn = (url: string, session: Session, options: ClientOptions) =>
  Effect.fnUntraced(
    function* (filter: Filter) {
      const first = yield* subscribe(session, filter)
      if (Result.isSuccess(first)) return first.success
      if (!authRequired(first.failure) || Option.isNone(options.auth)) return yield* session.fail('refused')
      yield* authenticate(url, session, options.auth.value)
      const again = yield* subscribe(session, filter)
      return Result.isSuccess(again) ? again.success : yield* session.fail('refused')
    },
    Effect.timeoutOrElse({
      duration: options.replyTimeout,
      orElse: () => Effect.fail(new RelayFailure({ relay: url, reason: 'timeout' })),
    }),
  )

/**
 * A NIP-01 connection to `url` over the standard `WebSocket` for the scope:
 * it opens within the connect timeout and closes when the scope does, whatever happened. No reconnecting: a dropped
 * connection fails what was waiting on it, and the caller connects again on its next run.
 */
export const connectRelay = Effect.fnUntraced(function* (
  url: string,
  options: ClientOptions,
): Effect.fn.Return<RelayConnection, RelayFailure, Scope.Scope> {
  const unreachable = new RelayFailure({ relay: url, reason: 'unreachable' })
  const inbound = yield* Queue.unbounded<Inbound>()
  const socket = yield* Effect.acquireRelease(
    Effect.try({ try: () => new WebSocket(url), catch: () => unreachable }).pipe(
      Effect.tap((created) => Effect.sync(() => listen(created, inbound, options.maxFrameLength))),
    ),
    closeQuietly,
  )
  yield* opened(socket, unreachable).pipe(
    Effect.timeoutOrElse({
      duration: options.connectTimeout,
      orElse: () => Effect.fail(new RelayFailure({ relay: url, reason: 'timeout' })),
    }),
  )
  const session = sessionOf(url, socket, inbound, options)
  return { url, publish: publishOn(url, session, options), query: queryOn(url, session, options) }
})
