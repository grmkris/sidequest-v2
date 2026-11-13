import { Digest, UnixSeconds } from '@sidequest/protocol'
import { type Effect, Schema } from 'effect'
import { EventId, type NostrEvent } from './Event.ts'
import type { PublicKey } from './PublicKey.ts'
import type { RelayUrl } from './RelayList.ts'
import { RoomFounding, RoomMessage } from './RoomMessage.ts'

// What the room layer needs from its host, and nothing else: a way to talk to relays, a way to learn where someone
// receives private messages, and a place to keep its state. The browser gives it the relay pipe, the index and
// IndexedDB; the agent gateway gives it a Worker's WebSocket, the index and D1; tests give it memory.

/** Why one relay did not answer as asked: unreachable, too slow, the connection dropped, a message too large, a
 * refusal, or a refused authentication. Rooms report it per relay and carry on with the others. */
export class RelayPortFailure extends Schema.TaggedError<RelayPortFailure>()('RelayPortFailure', {
  relay: Schema.String,
  reason: Schema.Literals(['unreachable', 'timeout', 'dropped', 'oversize', 'refused', 'authFailed']),
}) {}

/** A relay's answer to an `EVENT`: accepted or not, and its message (`duplicate: …`, `auth-required: …`, …). */
export interface RelayAck {
  readonly accepted: boolean
  readonly message: string
}

/** The one filter rooms ask with: the gift wraps tagged with one key, in a window, newest first, at most `limit`. */
export interface InboxFilter {
  readonly kinds: ReadonlyArray<number>
  readonly '#p': ReadonlyArray<PublicKey>
  readonly since?: number
  readonly until?: number
  readonly limit: number
}

/**
 * NIP-01 as rooms use it: publish one event, or `REQ` a filter until `EOSE`, then `CLOSE`. An implementation answers a
 * relay's NIP-42 challenge with the member's signer, retries as its transport warrants, and never keeps a subscription
 * open: rooms poll.
 */
export interface RelayPort {
  readonly publish: (relay: RelayUrl, event: NostrEvent) => Effect.Effect<RelayAck, RelayPortFailure>
  readonly query: (relay: RelayUrl, filter: InboxFilter) => Effect.Effect<ReadonlyArray<unknown>, RelayPortFailure>
}

/** Where someone receives private messages (their kind-10050 relays), as the host knows it; empty when it does not. */
export interface InboxDirectory {
  readonly inboxRelays: (pubkey: PublicKey) => Effect.Effect<ReadonlyArray<RelayUrl>>
}

/** A gift wrap already handled, with its (backdated) time, so it is neither fetched into the room twice nor kept
 * forever: once every relay's look-back starts after `at`, no poll can fetch it again. */
export const SeenWrap = Schema.Struct({ wrap: EventId, at: UnixSeconds })
export type SeenWrap = typeof SeenWrap.Type

/** When the last complete poll of one inbox relay started. */
export const RelayCursor = Schema.Struct({ relay: Schema.String, polledAt: UnixSeconds })
export type RelayCursor = typeof RelayCursor.Type

/**
 * Everything one member's room layer keeps: the rooms it is in, the messages it read in them (dropped ones too, so the
 * transcript can be recomputed and the drops counted), the wraps it handled, and its cursors. The host decides what of
 * it reaches storage: the gateway keeps no text.
 */
export const RoomState = Schema.Struct({
  rooms: Schema.Array(RoomFounding),
  messages: Schema.Array(RoomMessage),
  seen: Schema.Array(SeenWrap),
  cursors: Schema.Array(RelayCursor),
})
export type RoomState = typeof RoomState.Type

export const emptyRoomState: RoomState = { rooms: [], messages: [], seen: [], cursors: [] }

/** Where the room layer keeps its state. A store that cannot keep anything still works, for as long as it lives. */
export interface RoomStore {
  readonly load: Effect.Effect<RoomState>
  readonly save: (state: RoomState) => Effect.Effect<void>
}

/** A room's id: `roomIdOf` of its job and founding members. */
export const RoomId = Digest
export type RoomId = typeof RoomId.Type
