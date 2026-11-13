import { type NostrEvent, verifyEvent } from '@sidequest/nostr'
import { standardKinds } from '@sidequest/nostr/vocabulary'
import { Effect, Option, Result, Schema } from 'effect'
import { type Peer, serveWebSockets } from './WebSocketServer.ts'

// An in-process NIP-01 relay for tests, over a real WebSocket on 127.0.0.1. It stores what it is sent, answers REQ
// newest first up to its own page limit, and can be told to misbehave: demand NIP-42 authentication, refuse events,
// drop connections, never end a subscription, or send a message too large to read. As a NIP-17 inbox relay it can
// also keep gift wraps (kind 1059) for their recipients alone: reading them needs authentication, and a reader gets
// only the wraps tagged with the key it authenticated as.

/** How the relay behaves; tests change it between runs. */
export interface Behaviour {
  /** Demand NIP-42 authentication before serving REQ and EVENT. */
  auth: boolean
  /** The most events one REQ answers, whatever the filter's `limit` asks: a relay's own cap. */
  pageLimit: number
  /** An `OK false` message for an event it refuses, or nothing to accept it. */
  refuse: (event: NostrEvent) => string | undefined
  /** Drop every new connection at once. */
  unreachable: boolean
  /** Drop the connection on the REQ after this many have been answered (counted across connections). */
  dropAfterRequests: number
  /** Answer REQ with its events but never EOSE. */
  silent: boolean
  /** Answer REQ with one NOTICE this long first. */
  noticeLength: number
  /** Serve gift wraps only to their recipients: a REQ for them needs authentication first. */
  wrapsForRecipients: boolean
}

const Filter = Schema.Struct({
  kinds: Schema.optional(Schema.Array(Schema.Int)),
  authors: Schema.optional(Schema.Array(Schema.String)),
  since: Schema.optional(Schema.Int),
  until: Schema.optional(Schema.Int),
  limit: Schema.optional(Schema.Int),
  '#p': Schema.optional(Schema.Array(Schema.String)),
})
type Filter = typeof Filter.Type

const Message = Schema.fromJsonString(
  Schema.Union([
    Schema.Tuple([Schema.Literal('EVENT'), Schema.Unknown]),
    Schema.Tuple([Schema.Literal('AUTH'), Schema.Unknown]),
    Schema.Tuple([Schema.Literal('REQ'), Schema.String, Filter]),
    Schema.Tuple([Schema.Literal('CLOSE'), Schema.String]),
  ]),
)
const decodeMessage = Schema.decodeUnknownOption(Message)

const matches = (filter: Filter, event: NostrEvent) =>
  (filter.kinds === undefined || filter.kinds.includes(event.kind)) &&
  (filter.authors === undefined || filter.authors.includes(event.pubkey)) &&
  (filter.since === undefined || event.created_at >= filter.since) &&
  (filter.until === undefined || event.created_at <= filter.until) &&
  (filter['#p'] === undefined || event.tags.some((tag) => tag[0] === 'p' && filter['#p']?.includes(tag[1] ?? '')))

const asksForWraps = (filter: Filter) => filter.kinds?.includes(standardKinds.giftWrap) ?? true

/** A gift wrap only its recipient may read, when the relay keeps them so; any other event, anyone. */
const readableBy = (reader: Option.Option<string>) => (event: NostrEvent) =>
  event.kind !== standardKinds.giftWrap ||
  Option.exists(reader, (key) => event.tags.some((tag) => tag[0] === 'p' && tag[1] === key))

const newestFirst = (a: NostrEvent, b: NostrEvent) => b.created_at - a.created_at || a.id.localeCompare(b.id)

const send = (peer: Peer, message: ReadonlyArray<unknown>) => peer.send(JSON.stringify(message))

/** The key a NIP-42 answer authenticates, if it is a valid kind-22242 event for this challenge. */
const authenticatedBy = (input: unknown, challenge: string) => {
  const verified = verifyEvent(input)
  if (Result.isFailure(verified)) return { id: '', key: Option.none<string>() }
  const event = verified.success
  const valid =
    event.kind === standardKinds.clientAuth && event.tags.some((tag) => tag[0] === 'challenge' && tag[1] === challenge)
  return { id: event.id, key: valid ? Option.some(event.pubkey) : Option.none<string>() }
}

/** Why a REQ needs authentication first, if it does. */
const authNeeded = (behaviour: Behaviour, reader: Option.Option<string>, filter: Filter): string | undefined => {
  if (Option.isSome(reader)) return undefined
  if (behaviour.auth) return 'auth-required: authenticate first'
  const wraps = behaviour.wrapsForRecipients && asksForWraps(filter)
  return wraps ? 'auth-required: gift wraps are for their recipients' : undefined
}

/** A relay that behaves: open, accepting, answering every REQ to its end. */
const wellBehaved: Behaviour = {
  auth: false,
  pageLimit: 500,
  refuse: () => undefined,
  unreachable: false,
  dropAfterRequests: Number.POSITIVE_INFINITY,
  silent: false,
  noticeLength: 0,
  wrapsForRecipients: false,
}

/** A running test relay: its URL, what it holds and was asked, its behaviour, and a way to stop it. */
export const startTestRelay = async (overrides: Partial<Behaviour> = {}) => {
  const behaviour: Behaviour = { ...wellBehaved, ...overrides }
  const events = new Map<string, NostrEvent>()
  const requests: Array<Filter> = []
  const published: Array<string> = []
  const authenticated = new Set<string>()
  const handshakes: Array<Readonly<Record<string, unknown>>> = []
  let answered = 0

  const onEvent = (peer: Peer, authed: boolean, input: unknown) => {
    const verified = verifyEvent(input)
    if (Result.isFailure(verified)) return send(peer, ['OK', '', false, 'invalid: bad event'])
    const event = verified.success
    if (behaviour.auth && !authed) return send(peer, ['OK', event.id, false, 'auth-required: authenticate first'])
    if (events.has(event.id)) return send(peer, ['OK', event.id, true, 'duplicate: already have it'])
    const refusal = behaviour.refuse(event)
    if (refusal !== undefined) return send(peer, ['OK', event.id, false, refusal])
    events.set(event.id, event)
    published.push(event.id)
    send(peer, ['OK', event.id, true, ''])
  }

  const onRequest = (peer: Peer, reader: Option.Option<string>, id: string, filter: Filter) => {
    const needed = authNeeded(behaviour, reader, filter)
    if (needed !== undefined) return send(peer, ['CLOSED', id, needed])
    if (answered >= behaviour.dropAfterRequests) return peer.drop()
    answered += 1
    requests.push(filter)
    if (behaviour.noticeLength > 0) send(peer, ['NOTICE', 'x'.repeat(behaviour.noticeLength)])
    const limit = Math.min(filter.limit ?? Number.POSITIVE_INFINITY, behaviour.pageLimit)
    const readable = behaviour.wrapsForRecipients ? readableBy(reader) : () => true
    const found = [...events.values()]
      .filter((event) => matches(filter, event) && readable(event))
      .toSorted(newestFirst)
    for (const event of found.slice(0, limit)) send(peer, ['EVENT', id, event])
    if (!behaviour.silent) send(peer, ['EOSE', id])
  }

  const server = await serveWebSockets(
    (headers) => {
      handshakes.push({ ...headers })
      return !behaviour.unreachable
    },
    (peer) => {
      const challenge = crypto.randomUUID()
      let authedAs: Option.Option<string> = Option.none()
      send(peer, ['AUTH', challenge])
      const onAuth = (input: unknown) => {
        const { id, key } = authenticatedBy(input, challenge)
        if (Option.isSome(key)) authenticated.add(key.value)
        authedAs = Option.orElse(key, () => authedAs)
        send(peer, ['OK', id, Option.isSome(key), Option.isSome(key) ? '' : 'invalid: bad auth'])
      }
      return {
        onText: (text) => {
          const message = decodeMessage(text)
          if (Option.isNone(message)) return send(peer, ['NOTICE', 'invalid: unreadable message'])
          const value = message.value
          if (value[0] === 'EVENT') return onEvent(peer, Option.isSome(authedAs), value[1])
          if (value[0] === 'AUTH') return onAuth(value[1])
          if (value[0] === 'REQ') return onRequest(peer, authedAs, value[1], value[2])
        },
      }
    },
  )

  return {
    url: server.url,
    behaviour,
    /** The events the relay holds, by id. */
    events,
    /** Stores events as if someone had published them. */
    seed: (...seeded: ReadonlyArray<NostrEvent>) => {
      for (const event of seeded) events.set(event.id, event)
    },
    /** Every filter it answered, in order. */
    requests,
    /** The ids it stored from EVENT messages, in order. */
    published,
    /** The keys that authenticated, ever. */
    authenticated,
    /** The headers of every connection's opening handshake, in order. */
    handshakes,
    close: server.close,
  }
}

export type TestRelay = Awaited<ReturnType<typeof startTestRelay>>

/** Test relays for one test, each with its own behaviour, closed afterwards whatever happened. */
export const withRelays = <A, E>(
  settings: ReadonlyArray<Partial<Behaviour>>,
  use: (relays: ReadonlyArray<TestRelay>) => Effect.Effect<A, E>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => Promise.all(settings.map((setting) => startTestRelay(setting)))),
    use,
    (relays) => Effect.promise(() => Promise.all(relays.map((relay) => relay.close()))),
  )
