import { Clock, Duration, Effect, Option, Queue, Result } from 'effect'
import type { RelayUrlPolicy } from '../Index/RelayUrls.ts'
import type { Admissions } from './PipeAdmission.ts'
import {
  type Close,
  dialUrlOf,
  type End,
  openedPipe,
  type PipeEvent,
  type PipeLimits,
  pipeStep,
  pipeTargetOf,
  type Side,
} from './PipePolicy.ts'

/**
 * The relay pipe: `GET /relay?url=<relay>` with `Upgrade: websocket` from a page of this site opens a WebSocket to that
 * relay and passes text messages both ways, so the browser reaches Nostr relays while the content security policy stays
 * `connect-src 'self'` (ADR-0003, decision 9). It stores nothing and reads nothing beyond the caps in `PipePolicy.ts`.
 *
 * It runs in the stateless edge Worker, not a Durable Object: an HTTP-triggered Worker has no duration limit while its
 * client stays connected, a Durable Object's hibernation is unavailable for outgoing WebSockets (and a pipe always holds
 * one), and a pipe has no state worth a single home. CPU time accrues per invocation (30 s by default) only while code
 * runs; a forwarded message costs a length check and a byte count, so the caps bound it.
 *
 * The admission bound is in the isolate's memory (`PipeAdmission.ts`), not the index's D1 `RateLimiter`: the edge has
 * no database binding and no Effect runtime of the API's, a concurrent-pipe count needs a decrement that a crashed
 * isolate would never make, and a D1 write per connect would cost more than the pipe it guards.
 */
export interface PipeSettings {
  readonly policy: RelayUrlPolicy
  readonly limits: PipeLimits
  readonly admissions: Admissions
}

/** The upgrade to a relay, from the edge's `fetch`, with a fresh header set: no cookie, authorization or other header of
 * the visitor's reaches the relay. Outside Effect, so the Effect only sees a promise. */
const dial = (url: string, signal: AbortSignal) => fetch(url, { headers: { upgrade: 'websocket' }, signal })

const respond = (status: number) => new Response(null, { status })

/** The relay's socket, accepted, if it answered the upgrade within the connect limit. */
const dialRelay = (relay: string, limits: PipeLimits) =>
  Effect.tryPromise({ try: (signal) => dial(dialUrlOf(relay), signal), catch: () => 'unreachable' as const }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(limits.connectMillis),
      orElse: () => Effect.fail('timeout' as const),
    }),
    Effect.map((response) => Option.fromNullishOr(response.webSocket)),
    Effect.catch(() => Effect.succeed(Option.none<WebSocket>())),
  )

/** Each socket event onto the queue the pipe reads; never the message's contents anywhere else. */
const listen = (socket: WebSocket, from: Side, inbound: Queue.Queue<PipeEvent>) => {
  socket.addEventListener(
    'message',
    (event: MessageEvent) => void Queue.offerUnsafe(inbound, { from, message: event.data }),
  )
  socket.addEventListener(
    'close',
    (event: CloseEvent) =>
      void Queue.offerUnsafe(inbound, { from, closed: { code: event.code, reason: event.reason } }),
  )
  socket.addEventListener('error', () => void Queue.offerUnsafe(inbound, { from, error: true }))
}

const closeQuietly = (socket: WebSocket, { code, reason }: Close) =>
  Effect.ignore(Effect.try(() => socket.close(code, reason)))

/** Sends `text`, or reports the socket's error when it can no longer send. */
const sendOn = (socket: WebSocket, from: Side, text: string) =>
  Effect.try({ try: () => socket.send(text), catch: () => 'failed' as const }).pipe(
    Effect.as(Option.none<PipeEvent>()),
    Effect.catch(() => Effect.succeed(Option.some<PipeEvent>({ from, error: true }))),
  )

/** Runs a pipe until either side ends it, closes both, and logs what passed: counts and sizes, never contents. */
const runPipe = Effect.fn('Sidequest.RelayPipe.pipe')(function* (
  sockets: { readonly client: WebSocket; readonly relay: WebSocket },
  inbound: Queue.Queue<PipeEvent>,
  host: string,
  limits: PipeLimits,
) {
  const started = yield* Clock.currentTimeMillis
  let state = openedPipe(started, limits)
  let pending: Option.Option<PipeEvent> = Option.none()
  let end: Option.Option<End> = Option.none()
  while (Option.isNone(end)) {
    const event = Option.isSome(pending)
      ? pending.value
      : Option.getOrElse(
          yield* Queue.take(inbound).pipe(Effect.timeoutOption(Duration.millis(limits.idleMillis))),
          (): PipeEvent => ({ idle: true }),
        )
    const step = pipeStep(state, event, yield* Clock.currentTimeMillis, limits)
    state = step.state
    if ('end' in step) end = Option.some(step.end)
    else pending = yield* sendOn(sockets[step.forward.to], step.forward.to, step.forward.text)
  }
  const ended = end.value
  yield* closeQuietly(sockets.client, ended.client)
  yield* closeQuietly(sockets.relay, ended.relay)
  const fields = {
    'sidequest.relay.host': host,
    'sidequest.pipe.duration_ms': (yield* Clock.currentTimeMillis) - started,
    'sidequest.pipe.frames_to_relay': state.traffic.framesToRelay,
    'sidequest.pipe.bytes_to_relay': state.traffic.bytesToRelay,
    'sidequest.pipe.frames_to_client': state.traffic.framesToClient,
    'sidequest.pipe.bytes_to_client': state.traffic.bytesToClient,
    'sidequest.pipe.end': ended.reason,
    'sidequest.pipe.client_code': ended.client.code,
    'sidequest.pipe.relay_code': ended.relay.code,
  }
  yield* Effect.annotateCurrentSpan(fields)
  yield* Effect.logInfo('Sidequest.RelayPipe.closed').pipe(Effect.annotateLogs(fields))
})

/**
 * Answers an upgrade request to `/relay`: refused with 405, 426, 403 or 400 (see `pipeTargetOf`), 429 when the client
 * address holds or opens too many pipes, 502 when the relay does not accept; otherwise 101, with the pipe running
 * until either side ends it.
 */
export const openRelayPipe = Effect.fn('Sidequest.RelayPipe.open')(function* (
  request: Request,
  settings: PipeSettings,
) {
  const target = pipeTargetOf(request, settings.policy)
  if (Result.isFailure(target)) {
    yield* Effect.logInfo('Sidequest.RelayPipe.refused').pipe(
      Effect.annotateLogs({ 'sidequest.pipe.refused': target.failure.reason }),
    )
    return respond(target.failure.status)
  }
  const { relay, host } = target.success
  yield* Effect.annotateCurrentSpan({ 'sidequest.relay.host': host })
  // The address Cloudflare saw; absent only where nothing sets it (local workerd), where every client shares a bound.
  const address = request.headers.get('cf-connecting-ip') ?? 'unknown'
  const verdict = settings.admissions.take(address, yield* Clock.currentTimeMillis)
  if (verdict !== 'admitted') {
    yield* Effect.logInfo('Sidequest.RelayPipe.refused').pipe(
      Effect.annotateLogs({ 'sidequest.pipe.refused': verdict }),
    )
    return respond(429)
  }
  const release = Effect.sync(() => settings.admissions.release(address))
  const upstream = yield* dialRelay(relay, settings.limits)
  if (Option.isNone(upstream)) {
    yield* release
    yield* Effect.logInfo('Sidequest.RelayPipe.refused').pipe(
      Effect.annotateLogs({ 'sidequest.pipe.refused': 'relayUnreachable', 'sidequest.relay.host': host }),
    )
    return respond(502)
  }
  const pair = new WebSocketPair()
  const sockets = { client: pair[1], relay: upstream.value }
  const inbound = yield* Queue.unbounded<PipeEvent>()
  sockets.client.accept()
  sockets.relay.accept()
  listen(sockets.client, 'client', inbound)
  listen(sockets.relay, 'relay', inbound)
  yield* Effect.forkDetach(runPipe(sockets, inbound, host, settings.limits).pipe(Effect.ensuring(release)))
  return new Response(null, { status: 101, webSocket: pair[0] })
})
