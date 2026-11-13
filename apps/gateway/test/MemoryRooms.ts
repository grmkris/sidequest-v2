import type { NostrEvent, PublicKey } from '@sidequest/nostr'
import type { RelayPort } from '@sidequest/nostr/rooms'
import type { RelayUrl } from '@sidequest/nostr/vocabulary'
import { Effect, Layer } from 'effect'
import { RoomNetwork } from '../src/Rooms/RoomNetwork.ts'

// The relays and inbox lists room tools reach, in memory: one shared store of events per relay URL, filtered as a relay
// filters a REQ (kinds, `#p`, `since`, `until`), newest first, `limit` at most. The native test proves the real ones.

/** What a test reads and sets: each relay's events, and every key's inbox relays. */
export interface MemoryRooms {
  readonly relays: Map<string, Array<NostrEvent>>
  readonly inbox: Map<PublicKey, ReadonlyArray<RelayUrl>>
  readonly port: RelayPort
  readonly layer: Layer.Layer<RoomNetwork>
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
  const layer = Layer.succeed(RoomNetwork, {
    port: () => port,
    inboxRelays: (pubkey) => Effect.succeed(inbox.get(pubkey) ?? []),
    allows: () => true,
  })
  return { relays, inbox, port, layer }
}
