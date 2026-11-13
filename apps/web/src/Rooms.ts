import type { NostrEvent } from '@sidequest/nostr'
import { AssetId, type Person } from '@sidequest/protocol'
import { Array, Clock, Context, Effect, Exit, Layer, Option, Ref, Schema } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import { SidequestClient } from './Api.ts'
import { Marks } from './Marks.ts'
import type * as RoomKit from './RoomKit.ts'
import { Signers } from './Signer.ts'

// Rooms in the browser (ADR-0004): the job page's end-to-end encrypted conversations, NIP-17 gift wraps on the
// members' inbox relays, reached through the edge's relay pipe. Nothing of a room reaches Sidequest's servers. This
// module holds no Nostr code: `RoomKit.ts` loads the first time a room opens. The Model holds only the plain shapes
// below, read out of the transcripts.

/** A private proposal as the room carried it: the bidder's signed proposal event, verified, and what it offers. */
export const PrivateProposal = Schema.Struct({
  id: Schema.String,
  author: Schema.String,
  title: Schema.String,
  amount: Schema.String,
  asset: AssetId,
  deliveryDeadline: Schema.Int,
  validUntil: Schema.Int,
  event: Schema.String,
})
export type PrivateProposal = typeof PrivateProposal.Type

/** One message of a room as the panel shows it, in the room's order. */
export const RoomLine = Schema.Struct({
  id: Schema.String,
  author: Schema.String,
  createdAt: Schema.Int,
  act: Schema.Literals(['text', 'add', 'remove', 'proposal']),
  text: Schema.String,
  maybeMember: Schema.Option(Schema.String),
  maybeProposal: Schema.Option(PrivateProposal),
  viaGateway: Schema.Boolean,
})
export type RoomLine = typeof RoomLine.Type

/** A member that is an agent under a grant (a gateway-held agent, when its messages say so), with the grant's label. */
export const RoomAgent = Schema.Struct({ pubkey: Schema.String, label: Schema.String })
export type RoomAgent = typeof RoomAgent.Type

/** One room: the bidder it is with, its messages, its members, the agents among them, and how many messages it
 * dropped. */
export const RoomSnapshot = Schema.Struct({
  room: Schema.String,
  bidder: Schema.String,
  lines: Schema.Array(RoomLine),
  members: Schema.Array(Schema.String),
  agents: Schema.Array(RoomAgent),
  dropped: Schema.Int,
})
export type RoomSnapshot = typeof RoomSnapshot.Type

/** How one inbox relay answered the last pass: read, or why not. */
export const RelayState = Schema.Struct({ relay: Schema.String, outcome: Schema.String })
export type RelayState = typeof RelayState.Type

/** A pass over the person's rooms for one job. `noInbox` when they have no inbox relay to read. */
export const RoomsRead = Schema.Struct({
  rooms: Schema.Array(RoomSnapshot),
  relays: Schema.Array(RelayState),
  noInbox: Schema.Boolean,
  /** The signer can give one message's keys away as evidence: a key held in this browser can, an extension cannot. */
  canDisclose: Schema.Boolean,
})
export type RoomsRead = typeof RoomsRead.Type

/** How far a message went: copies delivered to a relay, of the copies there were to deliver. */
export const Delivered = Schema.Struct({ sent: Schema.Int, total: Schema.Int })
export type Delivered = typeof Delivered.Type

/** Why rooms are unavailable or refused: no signer ready, a signer without NIP-44 (an extension without `nip44`),
 * the room code did not load, the room layer refused (`refused`), or a relay or store failed. */
export const RoomsFailure = Schema.Literals([
  'locked',
  'noNip44',
  'notLoaded',
  'notMember',
  'badBody',
  'cannotDisclose',
  'signerRefused',
  'failed',
])
export type RoomsFailure = typeof RoomsFailure.Type

export class RoomsFailed extends Schema.TaggedError<RoomsFailed>()('RoomsFailed', { reason: RoomsFailure }) {}

/** How many messages in a job's rooms the person has not seen, as this browser's room store and marks count them. */
export const UnreadOnJob = Schema.Struct({ job: Schema.String, count: Schema.Int })
export type UnreadOnJob = typeof UnreadOnJob.Type

/** A job's rooms as the person sees them: the buyer's with each bidder, or a bidder's own with the buyer. */
export interface JobRooms {
  readonly job: string
  readonly buyer: string
  readonly bidders: ReadonlyArray<string>
}

/** What a disclosure proves, as the evidence page shows it. */
export interface CheckedDisclosure {
  readonly author: string
  readonly createdAt: number
  readonly text: string
  readonly maybeRoom: Option.Option<string>
}

export class Rooms extends Context.Service<
  Rooms,
  {
    /** Opens the job's rooms for the person's key and reads every inbox relay once. */
    readonly sync: (rooms: JobRooms) => Effect.Effect<RoomsRead, RoomsFailed>
    readonly sendText: (room: string, text: string) => Effect.Effect<Delivered, RoomsFailed>
    /** A bidder's signed proposal, kept private: sent only into their room with the job's buyer. */
    readonly sendProposal: (job: string, buyer: string, event: NostrEvent) => Effect.Effect<Delivered, RoomsFailed>
    /** One message's disclosure bundle, as JSON. */
    readonly disclose: (room: string, message: string) => Effect.Effect<string, RoomsFailed>
    /** Forgets a room's messages on this device. */
    readonly forget: (room: string) => Effect.Effect<void, RoomsFailed>
    /** Signs the person's kind-10050 list and sends it to those relays; the index gets it from the page. */
    readonly signInboxRelays: (relays: ReadonlyArray<string>) => Effect.Effect<NostrEvent, RoomsFailed>
    /** The person's unseen room messages per job, from this browser's store alone: no relay is read, nothing
     * decrypted, no signer needed. A message is seen once the job's room panel showed it. */
    readonly unread: (pubkey: string) => Effect.Effect<ReadonlyArray<UnreadOnJob>, RoomsFailed>
    /** Checks a pasted disclosure, with nothing but its text. */
    readonly verify: (text: string) => Effect.Effect<Option.Option<CheckedDisclosure>, RoomsFailed>
    /** The room code itself, for reading private proposals. */
    readonly kit: Effect.Effect<typeof RoomKit, RoomsFailed>
  }
>()('@sidequest/web/Rooms') {}

const failed = (reason: RoomsFailure) => new RoomsFailed({ reason })

/** How long the index's answer about someone's inbox relays is reused. */
const directoryMillis = 60_000

/** The rooms over the signers, the index (for inbox relays) and this page's origin. */
export const roomsLayer = (origin: string) =>
  Layer.effect(
    Rooms,
    Effect.gen(function* () {
      const signers = yield* Signers
      const client = yield* SidequestClient
      const marks = yield* Marks
      const kit = yield* Effect.cachedWithTTL(
        Effect.tryPromise({ try: () => import('./RoomKit.ts'), catch: () => failed('notLoaded') }),
        (exit) => (Exit.isSuccess(exit) ? 'Infinity' : 0),
      )
      const known = yield* Ref.make(new Map<string, { readonly person: Option.Option<Person>; readonly at: number }>())
      /** What the index knows of a key, reused for a minute: its inbox relays, and the grants it acts under. */
      const personOf = (pubkey: string) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const cached = (yield* Ref.get(known)).get(pubkey)
          if (cached !== undefined && now - cached.at < directoryMillis) return cached.person
          const api = yield* client.api
          const person = yield* api.events
            .person({ params: { pubkey } })
            .pipe(Effect.provideService(FetchHttpClient.RequestInit, { cache: 'no-cache' }), Effect.option)
          yield* Ref.update(known, (held) => new Map([...held, [pubkey, { person, at: now }]]))
          return person
        }).pipe(Effect.orElseSucceed(() => Option.none<Person>()))
      const inboxRelays = (pubkey: string) =>
        Effect.map(personOf(pubkey), (person) =>
          Option.match(person, { onNone: () => [], onSome: (found) => found.messagingRelays?.relays ?? [] }),
        )
      /** The members a founding member added that act under a grant: agents, labelled as their operator named them. */
      const agentsIn = (snapshot: RoomSnapshot, buyer: string) =>
        Effect.map(
          Effect.forEach(
            snapshot.members.filter((member) => member !== buyer && member !== snapshot.bidder),
            (member) =>
              Effect.map(personOf(member), (person) =>
                Option.flatMap(person, (found) =>
                  Option.map(Array.head(found.operators), (grant) => ({ pubkey: member, label: grant.label })),
                ),
              ),
          ),
          Array.getSomes,
        )
      const opened = yield* Ref.make(Option.none<{ readonly pubkey: string; readonly rooms: RoomsOf }>())
      const transport = Effect.gen(function* () {
        const signer = yield* Effect.mapError(signers.resume, () => failed('locked'))
        const roomSigner = yield* Option.match(signer.maybeRoomSigner, {
          onNone: () => Effect.fail(failed('noNip44')),
          onSome: Effect.succeed,
        })
        const held = yield* Ref.get(opened)
        if (Option.isSome(held) && held.value.pubkey === roomSigner.publicKey) return held.value.rooms
        const loaded = yield* kit
        const rooms = yield* loaded.openRooms(origin, roomSigner, inboxRelays)
        yield* Ref.set(opened, Option.some({ pubkey: roomSigner.publicKey, rooms }))
        return rooms
      })
      const service = roomsOver(transport, kit)
      // A key made in this browser holds its conversation keys; an extension keeps them to itself.
      const canDisclose = Effect.match(signers.resume, {
        onFailure: () => false,
        onSuccess: (signer) => signer.kind === 'local',
      })
      return Rooms.of({
        ...service,
        // The panel shows what a pass read: its rooms' messages are seen, which the inbox counts from.
        sync: (target) =>
          Effect.flatMap(Effect.zip(service.sync(target), canDisclose), ([read, disclosing]) =>
            Effect.map(
              Effect.forEach(read.rooms, (snapshot) =>
                Effect.map(agentsIn(snapshot, target.buyer), (agents) => ({ ...snapshot, agents })),
              ),
              (rooms) => ({ ...read, rooms, canDisclose: disclosing }),
            ),
          ).pipe(Effect.tap((read) => marks.markRoomsRead(read.rooms.map(newestShown)))),
        unread: (pubkey) =>
          Effect.gen(function* () {
            const loaded = yield* kit
            return loaded.unreadByJob(yield* loaded.storedState(pubkey), pubkey, yield* marks.roomsRead)
          }),
      })
    }),
  )

type RoomsOf = Effect.Success<ReturnType<typeof RoomKit.openRooms>>

/** A room's newest message as a pass showed it. */
const newestShown = (snapshot: RoomSnapshot) => ({
  room: snapshot.room,
  at: snapshot.lines.reduce((newest, line) => Math.max(newest, line.createdAt), 0),
})

/** The service's operations over the person's transport, which the kit does the work of. */
const roomsOver = (
  transport: Effect.Effect<RoomsOf, RoomsFailed>,
  kit: Effect.Effect<typeof RoomKit, RoomsFailed>,
): Omit<Rooms['Service'], 'unread'> => {
  const withKit = <A>(
    use: (loaded: typeof RoomKit, rooms: RoomsOf) => Effect.Effect<A, { readonly reason: RoomsFailure }>,
  ) =>
    Effect.flatMap(kit, (loaded) =>
      Effect.flatMap(transport, (rooms) => Effect.mapError(use(loaded, rooms), (error) => failed(error.reason))),
    )
  return {
    sync: (job) => withKit((loaded, rooms) => loaded.syncJob(rooms, job)),
    sendText: (room, text) => withKit((loaded, rooms) => loaded.sendBody(rooms, room, { _tag: 'Text', text })),
    sendProposal: (job, buyer, event) => withKit((loaded, rooms) => loaded.sendProposalTo(rooms, job, buyer, event)),
    disclose: (room, message) => withKit((loaded, rooms) => loaded.discloseJson(rooms, room, message)),
    forget: (room) => withKit((loaded, rooms) => loaded.forgetRoom(rooms, room)),
    signInboxRelays: (relays) => withKit((loaded, rooms) => loaded.publishInbox(rooms, relays)),
    verify: (text) => Effect.map(kit, (loaded) => loaded.checkPasted(text)),
    kit,
  }
}
