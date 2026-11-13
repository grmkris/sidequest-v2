import { webCrypto } from '@sidequest/protocol'
import { Crypto, Effect, Option, Predicate, Ref, Schema } from 'effect'
import { TestClock } from 'effect/testing'
import type { NostrEvent } from '../src/Event.ts'
import { publicKeyOf, type SecretKey } from '../src/Keys.ts'
import type { PublicKey } from '../src/PublicKey.ts'
import { RelayUrl } from '../src/RelayList.ts'
import { defaultRoomOptions, makeNip17Rooms, type RoomOptions } from '../src/Nip17Rooms.ts'
import { emptyRoomState, type InboxFilter, type RelayPort, RelayPortFailure, type RoomState } from '../src/RoomPorts.ts'
import type { RoomMessage } from '../src/RoomMessage.ts'
import { localRoomSigner, type RoomSigner } from '../src/RoomSigner.ts'
import { secret } from './fixtures.ts'

// Rooms over memory: relays that keep what they are sent and answer a filter newest first up to their own page cap,
// as public relays do, an inbox directory, and stores that keep a member's state between "processes".

/** A relay URL for tests. */
export const relayUrl = (name: string) => Schema.decodeSync(RelayUrl)(`wss://${name}.relay.test`)

/** Unix seconds the stories start at: 2027-01-15. */
export const startSeconds = 1_800_000_000

const newestFirst = (a: NostrEvent, b: NostrEvent) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1)

const matches = (filter: InboxFilter, event: NostrEvent) =>
  filter.kinds.includes(event.kind) &&
  event.tags.some((tag) => tag[0] === 'p' && filter['#p'].some((key) => key === tag[1])) &&
  (filter.since === undefined || event.created_at >= filter.since) &&
  (filter.until === undefined || event.created_at <= filter.until)

/** Relays in memory: every event each holds, the filters asked, and relays that are down. */
export const memoryRelays = (pageCap = 500) => {
  const held = new Map<string, Map<string, NostrEvent>>()
  const down = new Set<string>()
  const asked: Array<InboxFilter> = []
  const relayOf = (relay: string) => {
    const found = held.get(relay) ?? new Map<string, NostrEvent>()
    held.set(relay, found)
    return found
  }
  const port: RelayPort = {
    publish: (relay, event) =>
      down.has(relay)
        ? Effect.fail(new RelayPortFailure({ relay, reason: 'unreachable' }))
        : Effect.sync(() => {
            relayOf(relay).set(event.id, event)
            return { accepted: true, message: '' }
          }),
    query: (relay, filter) =>
      down.has(relay)
        ? Effect.fail(new RelayPortFailure({ relay, reason: 'timeout' }))
        : Effect.sync(() => {
            asked.push(filter)
            const found = [...relayOf(relay).values()].filter((event) => matches(filter, event)).toSorted(newestFirst)
            return found.slice(0, Math.min(filter.limit, pageCap))
          }),
  }
  return { port, held: relayOf, down, asked }
}

export type MemoryRelays = ReturnType<typeof memoryRelays>

/** A store whose state outlives the member that used it, as IndexedDB or D1 does. */
export const memoryStore = Effect.map(Ref.make<RoomState>(emptyRoomState), (state) => ({
  state,
  store: { load: Ref.get(state), save: (next: RoomState) => Ref.set(state, next) },
}))

/** A member: a key, its signer, its inbox relays in the directory, and its rooms over the shared relays. */
export const memberOf = (
  network: MemoryRelays,
  directory: Map<PublicKey, ReadonlyArray<RelayUrl>>,
  key: SecretKey,
  options: Partial<RoomOptions> = {},
  signer: RoomSigner = localRoomSigner(key, webCrypto),
) =>
  Effect.gen(function* () {
    const kept = yield* memoryStore
    const open = makeNip17Rooms(
      {
        signer,
        relays: network.port,
        directory: { inboxRelays: (pubkey) => Effect.succeed(directory.get(pubkey) ?? []) },
        store: kept.store,
      },
      { ...defaultRoomOptions, ...options },
    ).pipe(Effect.provideService(Crypto.Crypto, webCrypto))
    return { key, pubkey: publicKeyOf(key), rooms: yield* open, reopen: open, kept }
  })

/** Three keys: a buyer, a bidder, and the bidder's agent. */
export const buyerKey = secret('11'.repeat(32))
export const bidderKey = secret('22'.repeat(32))
export const agentKey = secret('33'.repeat(32))
export const strangerKey = secret('44'.repeat(32))

/** Starts the test clock at {@link startSeconds}. */
export const atStart = TestClock.setTime(startSeconds * 1000)

/** The text of every message in a transcript, in order. */
export const textsOf = (messages: ReadonlyArray<RoomMessage>) =>
  messages.flatMap((message) =>
    Predicate.isTagged(message.act, 'Text') ? Option.toArray(Option.fromNullishOr(message.act.text)) : [],
  )
