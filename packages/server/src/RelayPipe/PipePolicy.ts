import { Option, Result } from 'effect'
import { defaultTiming } from '../Index/IndexConfig.ts'
import { type RelayUrlPolicy, relayUrlOf } from '../Index/RelayUrls.ts'

// The relay pipe's rules, as pure functions: which upgrade requests it serves, and what it does with each frame and
// each end of a pipe. `RelayPipe.ts` wires them to sockets; nothing here touches one.

/**
 * The pipe's caps. Lengths are in UTF-16 code units, as the index measures them (`eventLimits`, `RelayTiming`), so a
 * length check is O(1) on the string the runtime hands over; a code unit is at most three UTF-8 bytes.
 *
 * - `clientFrameLength`: the largest message a page sends is `["EVENT", event]`. The index accepts an event whose
 *   canonical serialization is up to `eventLimits.serializedLength` (131,072); the wire form adds the id, signature,
 *   field names and the envelope, about 300 more. 129 KiB leaves room for that and refuses anything larger, which no
 *   relay the index reads would keep. A cap of 64 KiB would refuse events the index itself accepts.
 * - `relayFrameLength`: what the index reads from a relay (`defaultTiming.maxFrameLength`, 256 KiB): one stored event
 *   of the largest size with its `["EVENT", id, …]` envelope, and room for long NOTICEs.
 * - `clientBurst`, `clientPerSecond`: a token bucket per socket, 120 messages a minute sustained with a burst of 60. A
 *   page opening subscriptions sends a REQ per stream, and a room message is one gift wrap per member (two to six);
 *   publish-through allows a client 120 events a minute (`publishLimits.perClient`), and this matches it.
 * - `idleMillis`: neither side sent a message for two minutes. WebSocket pings are answered by the runtime and do not
 *   count; a page that wants to hold a quiet subscription open re-sends something, or reconnects.
 * - `connectMillis`: the relay must accept the upgrade within the index's connect timeout.
 */
export const pipeLimits = {
  clientFrameLength: 132_096,
  relayFrameLength: defaultTiming.maxFrameLength,
  clientBurst: 60,
  clientPerSecond: 2,
  idleMillis: 120_000,
  connectMillis: 5_000,
} as const

/** The pipe's caps, for a test that shrinks them. */
export type PipeLimits = { readonly [K in keyof typeof pipeLimits]: number }

/** Why an upgrade request is refused, and the HTTP status it is refused with. */
export type PipeRefusal =
  | { readonly status: 405; readonly reason: 'method' }
  | { readonly status: 426; readonly reason: 'upgrade' }
  | { readonly status: 403; readonly reason: 'origin' }
  | { readonly status: 400; readonly reason: 'url' }

/** The parts of an upgrade request the pipe reads. */
export interface UpgradeRequest {
  readonly method: string
  readonly url: string
  readonly headers: { readonly get: (name: string) => string | null }
}

/** A relay the pipe may open: its URL in normal spelling, and its host for telemetry. */
export interface PipeTarget {
  readonly relay: string
  readonly host: string
}

const refused = (refusal: PipeRefusal): Result.Result<PipeTarget, PipeRefusal> => Result.fail(refusal)

/**
 * The relay an upgrade request asks for, if the pipe serves it. In order:
 *
 * 1. `GET` only (405), with `Upgrade: websocket` (426).
 * 2. `Origin` must be this request's own origin (403). Browsers send it on every WebSocket handshake and pages cannot
 *    set it, and the same-origin policy does not cover WebSockets, so without this check any site could use the pipe
 *    from its visitors' browsers. A request without `Origin` is from no browser of ours, and is refused too.
 * 3. One `url` parameter that `policy` allows (`relayUrlOf`: `wss`, port 443, a public DNS name, no credentials), and
 *    not this site's own host, so the pipe never dials itself (400).
 */
export const pipeTargetOf = (
  request: UpgradeRequest,
  policy: RelayUrlPolicy,
): Result.Result<PipeTarget, PipeRefusal> => {
  if (request.method !== 'GET') return refused({ status: 405, reason: 'method' })
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return refused({ status: 426, reason: 'upgrade' })
  const site = new URL(request.url)
  if (request.headers.get('origin') !== site.origin) return refused({ status: 403, reason: 'origin' })
  const asked = site.searchParams.getAll('url')
  const relay = asked.length === 1 ? relayUrlOf(asked[0] ?? '', policy) : Option.none()
  if (Option.isNone(relay)) return refused({ status: 400, reason: 'url' })
  const host = new URL(relay.value).hostname
  return host === site.hostname ? refused({ status: 400, reason: 'url' }) : Result.succeed({ relay: relay.value, host })
}

/** The URL the edge's `fetch` dials for a relay: `wss` as `https`, `ws` as `http`, the rest unchanged. */
export const dialUrlOf = (relay: string): string => relay.replace(/^ws(s?):/u, 'http$1:')

/** A token bucket: tokens left, and when it was last filled (milliseconds). */
export interface Bucket {
  readonly tokens: number
  readonly at: number
}

/** A full bucket of `capacity`, at `now`. */
export const fullBucket = (capacity: number, now: number): Bucket => ({ tokens: capacity, at: now })

/** Takes one token, after refilling `perSecond` since the last take, up to `capacity`; none left, `taken` is false. */
export const takeToken = (bucket: Bucket, now: number, capacity: number, perSecond: number) => {
  const elapsed = Math.max(0, now - bucket.at)
  const tokens = Math.min(capacity, bucket.tokens + (elapsed * perSecond) / 1000)
  return tokens >= 1
    ? { taken: true, bucket: { tokens: tokens - 1, at: now } }
    : { taken: false, bucket: { tokens, at: now } }
}

/** Which side of a pipe: the page's socket, or the relay's. */
export type Side = 'client' | 'relay'

/** Why a pipe ended, as telemetry names it. */
export type EndReason =
  | 'clientClosed'
  | 'relayClosed'
  | 'clientError'
  | 'relayError'
  | 'idle'
  | 'clientFrameTooLarge'
  | 'relayFrameTooLarge'
  | 'clientBinary'
  | 'relayBinary'
  | 'clientRate'

/** A close frame to send: its code and reason. */
export interface Close {
  readonly code: number
  readonly reason: string
}

/** What a pipe does to end: the close each side gets, and why. */
export interface End {
  readonly client: Close
  readonly relay: Close
  readonly reason: EndReason
}

/** What happened on a socket: a message, its close with the peer's code and reason, or an error. */
export type PipeEvent =
  | { readonly from: Side; readonly message: unknown }
  | { readonly from: Side; readonly closed: Close }
  | { readonly from: Side; readonly error: true }
  | { readonly idle: true }

/** Counts of what a pipe forwarded each way: messages, and their UTF-8 bytes. */
export interface Traffic {
  readonly framesToRelay: number
  readonly bytesToRelay: number
  readonly framesToClient: number
  readonly bytesToClient: number
}

/** A pipe's state between events: its traffic and the client's rate bucket. */
export interface PipeState {
  readonly traffic: Traffic
  readonly bucket: Bucket
}

/** The state of a pipe opened at `now`. */
export const openedPipe = (now: number, limits: PipeLimits): PipeState => ({
  traffic: { framesToRelay: 0, bytesToRelay: 0, framesToClient: 0, bytesToClient: 0 },
  bucket: fullBucket(limits.clientBurst, now),
})

/** What a pipe does with one event: forward a text to a side, end, or nothing. */
export type Step =
  | { readonly state: PipeState; readonly forward: { readonly to: Side; readonly text: string } }
  | { readonly state: PipeState; readonly end: End }

/** UTF-8 bytes of `text`, without encoding it. */
export const utf8Length = (text: string): number => {
  let bytes = 0
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index)
    if (unit < 0x80) bytes += 1
    else if (unit < 0x800) bytes += 2
    else if (unit >= 0xd800 && unit < 0xdc00 && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1)
      const paired = next >= 0xdc00 && next < 0xe000
      bytes += paired ? 4 : 3
      if (paired) index += 1
    } else bytes += 3
  }
  return bytes
}

/** Codes a close frame may carry (RFC 6455 §7.4): 1004–1006 and 1015 are reserved, 1012–1014 are IANA-registered. */
const sendableCode = (code: number) =>
  (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999)

/** The longest close reason a frame carries is 123 UTF-8 bytes; cut longer ones at a code point. */
const reasonFits = (reason: string) => {
  let kept = ''
  for (const character of reason) {
    if (utf8Length(kept + character) > 123) break
    kept += character
  }
  return kept
}

// The pipe's own closes carry a code and no reason: the code is what a client acts on, and a reason would be English
// text in a frame no person reads.
const normal: Close = { code: 1000, reason: '' }
const binary: Close = { code: 1003, reason: '' }
const tooLarge: Close = { code: 1009, reason: '' }
const failed: Close = { code: 1011, reason: '' }

/**
 * The close one side's close becomes on the other: its code and reason where a frame may carry them; "no code"
 * (1005) as a normal close; an abnormal end (1006, 1015, anything else) as 1011, so the page knows the relay side
 * failed.
 */
export const forwardedClose = ({ code, reason }: Close): Close => {
  if (sendableCode(code)) return { code, reason: reasonFits(reason) }
  return code === 1005 ? normal : failed
}

/** Both sides closed with `close`, for `reason`. */
const endBoth = (state: PipeState, close: Close, reason: EndReason): Step => ({
  state,
  end: { client: close, relay: close, reason },
})

/** A message from `from`, checked against the caps; forwarded to the other side if it passes. */
const messageStep = (state: PipeState, from: Side, message: unknown, now: number, limits: PipeLimits): Step => {
  if (typeof message !== 'string') return endBoth(state, binary, from === 'client' ? 'clientBinary' : 'relayBinary')
  if (from === 'relay') {
    if (message.length > limits.relayFrameLength) return endBoth(state, tooLarge, 'relayFrameTooLarge')
    const { traffic } = state
    const counted = {
      ...traffic,
      framesToClient: traffic.framesToClient + 1,
      bytesToClient: traffic.bytesToClient + utf8Length(message),
    }
    return { state: { ...state, traffic: counted }, forward: { to: 'client', text: message } }
  }
  if (message.length > limits.clientFrameLength) return endBoth(state, tooLarge, 'clientFrameTooLarge')
  const take = takeToken(state.bucket, now, limits.clientBurst, limits.clientPerSecond)
  if (!take.taken) return { state, end: { client: { code: 1008, reason: '' }, relay: normal, reason: 'clientRate' } }
  const { traffic } = state
  const counted = {
    ...traffic,
    framesToRelay: traffic.framesToRelay + 1,
    bytesToRelay: traffic.bytesToRelay + utf8Length(message),
  }
  return { state: { traffic: counted, bucket: take.bucket }, forward: { to: 'relay', text: message } }
}

/**
 * The frame policy: what a pipe in `state` does with `event` at `now`. Text messages within the caps pass to the other
 * side and are counted; a binary message ends the pipe with 1003, an oversized one with 1009, a client over its rate
 * with 1008 (the relay gets a normal close). A side's close is forwarded to the other (`forwardedClose`); a side's error
 * closes the other with 1011; idleness closes both with 1001. The pipe never reads what a message says.
 */
export const pipeStep = (state: PipeState, event: PipeEvent, now: number, limits: PipeLimits): Step => {
  if ('idle' in event) return endBoth(state, { code: 1001, reason: '' }, 'idle')
  if ('message' in event) return messageStep(state, event.from, event.message, now, limits)
  if ('error' in event) return endBoth(state, failed, event.from === 'client' ? 'clientError' : 'relayError')
  const forwarded = forwardedClose(event.closed)
  return event.from === 'client'
    ? { state, end: { client: event.closed, relay: forwarded, reason: 'clientClosed' } }
    : { state, end: { client: forwarded, relay: event.closed, reason: 'relayClosed' } }
}
