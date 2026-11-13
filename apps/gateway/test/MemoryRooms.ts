import type { NostrEvent, PublicKey } from '@sidequest/nostr'
import type { SecretKey } from '@sidequest/nostr'
import {
  defaultRoomOptions,
  emptyRoomState,
  localRoomSigner,
  makeNip17Rooms,
  type RelayPort,
  type RoomState,
} from '@sidequest/nostr/rooms'
import type { RelayUrl } from '@sidequest/nostr/vocabulary'
import { webCrypto } from '@sidequest/protocol'
import { Crypto, Effect, Layer, Ref } from 'effect'
import { RoomNetwork } from '../src/Rooms/RoomNetwork.ts'

// The relays and inbox lists room tools reach, in memory: one shared store of events per relay URL, filtered as a relay
// filters a REQ (kinds, `#p`, `since`, `until`), newest first, `limit` at most. The native test proves the real ones.

/** What a test reads and sets: each relay's events, and every key's inbox relays. */
export interface MemoryRooms {
  readonly relays: Map<string, Array<NostrEvent>>
  readonly inbox: Map<PublicKey, ReadonlyArray<RelayUrl>>
  readonly port: RelayPort
  readonly layer: Layer.Layer<RoomNetwork>
  /** Holds the gateway's relay reads until `count` of them are waiting, so that many tool calls overlap for sure. */
  readonly overlapReads: (count: number) => void
}

const tagged = (event: NostrEvent, keys: ReadonlyArray<string>) =>
  event.tags.some(([name, value]) => name === 'p' && keys.some((key) => key === value))

export const memoryRooms = (): MemoryRooms => {
  const relays = new Map<string, Array<NostrEvent>>()
  const inbox = new Map<PublicKey, ReadonlyArray<RelayUrl>>()
  const held = (relay: string) => relays.get(relay) ?? relays.set(relay, []).get(relay) ?? []
  const port: RelayPort = {
    publish: (relay, event) =>
      Effect.sync(() => {
        const events = held(relay)
        if (!events.some(({ id }) => id === event.id)) events.push(event)
        return { accepted: true, message: '' }
      }),
    query: (relay, filter) =>
      Effect.sync(() =>
        held(relay)
          .filter(
            (event) =>
              filter.kinds.includes(event.kind) &&
              tagged(event, filter['#p']) &&
              event.created_at >= (filter.since ?? 0) &&
              event.created_at <= (filter.until ?? Number.MAX_SAFE_INTEGER),
          )
          .toSorted((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
          .slice(0, filter.limit),
      ),
  }
  const barrier = { waiting: 0, release: () => {}, released: Promise.resolve() }
  const overlapReads = (count: number) => {
    barrier.waiting = count
    barrier.released = new Promise((resolve) => {
      barrier.release = resolve
    })
  }
  const arrive = () => {
    barrier.waiting -= 1
    if (barrier.waiting <= 0) barrier.release()
    return barrier.released
  }
  const gateway: RelayPort = {
    publish: port.publish,
    query: (relay, filter) => Effect.andThen(Effect.promise(arrive), port.query(relay, filter)),
  }
  const layer = Layer.succeed(RoomNetwork, {
    port: () => gateway,
    inboxRelays: (pubkey) => Effect.succeed(inbox.get(pubkey) ?? []),
    allows: () => true,
  })
  return { relays, inbox, port, layer, overlapReads }
}

/**
 * A person's rooms held in the test process, as their browser would hold them: their own key, a store in memory, and
 * the relays and inbox lists the test gives.
 */
export const personRooms = (
  key: SecretKey,
  relays: RelayPort,
  inboxRelays: (pubkey: PublicKey) => Effect.Effect<ReadonlyArray<RelayUrl>>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const held = yield* Ref.make<RoomState>(emptyRoomState)
      return yield* makeNip17Rooms(
        {
          signer: localRoomSigner(key, webCrypto),
          relays,
          directory: { inboxRelays },
          store: { load: Ref.get(held), save: (next) => Ref.set(held, next) },
        },
        defaultRoomOptions,
      )
    }).pipe(Effect.provideService(Crypto.Crypto, webCrypto)),
  )
