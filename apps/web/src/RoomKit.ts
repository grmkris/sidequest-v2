import { EventId, type NostrEvent, PublicKey } from '@sidequest/nostr'
import { connectRelay, type RelayConnection } from '@sidequest/nostr/relay'
import {
  defaultRoomOptions,
  emptyRoomState,
  foundingOf,
  type RoomBody,
  RoomId,
  type RoomMessage,
  type RoomRefused,
  type Transcript,
  type InboxFilter,
  makeNip17Rooms,
  type RelayPort,
  RelayPortFailure,
  type RoomSigner,
  RoomState,
  type RoomStore,
  verifyDisclosure,
} from '@sidequest/nostr/rooms'
import { jobProposal, parseSidequestEvent, RelayUrl } from '@sidequest/nostr/vocabulary'
import { webCrypto } from '@sidequest/protocol'
import {
  Crypto,
  Duration,
  Effect,
  Exit,
  Match,
  Option,
  Predicate,
  Ref,
  Result,
  Schedule,
  Schema,
  Scope,
  Semaphore,
} from 'effect'
import type {
  CheckedDisclosure,
  Delivered,
  JobRooms,
  RoomLine,
  RoomsFailure,
  RoomsRead,
  RoomSnapshot,
  UnreadOnJob,
} from './Rooms.ts'

// The Nostr-heavy half of rooms in the browser, loaded as its own chunk the first time a room opens (see `Rooms.ts`):
// the relays through the edge's same-origin pipe, the room state in IndexedDB, and the NIP-17 transport over them.

/** The pipe's timeouts and the largest frame it passes from a relay (`PipePolicy.ts`). */
const clientOptions = (signer: RoomSigner) => ({
  connectTimeout: Duration.seconds(5),
  replyTimeout: Duration.seconds(10),
  maxFrameLength: 262_144,
  auth: Option.some((template: Parameters<RoomSigner['signEvent']>[0]) => signer.signEvent(template)),
})

/** The pipe's address for a relay, on this page's own origin (CSP `connect-src 'self'`). */
const pipeUrl = (origin: string, relay: string) =>
  `${origin.replace(/^http/u, 'ws')}/relay?url=${encodeURIComponent(relay)}`

interface Open {
  readonly connection: RelayConnection
  readonly scope: Scope.Closeable
}

const failure = (relay: string) => (error: { readonly reason: RelayPortFailure['reason'] }) =>
  new RelayPortFailure({ relay, reason: error.reason })

/** A failure worth one fresh connection: the pipe closed it (idle, a network change) or it went quiet. */
const reconnectable = (error: RelayPortFailure) => error.reason === 'dropped' || error.reason === 'timeout'

/**
 * Relays through the pipe. A connection per relay stays open between uses and is opened again on demand when the pipe
 * closed it (it closes after two idle minutes); one operation at a time per connection, as a relay's frames are read
 * in order. A publish is tried three times, a second and then two apart; a read once more on a fresh connection.
 */
export const pipeRelays = (origin: string, signer: RoomSigner) =>
  Effect.gen(function* () {
    const open = yield* Ref.make(new Map<string, Open>())
    const lock = yield* Semaphore.make(1)
    const connect = (relay: string) =>
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const connection = yield* connectRelay(pipeUrl(origin, relay), clientOptions(signer)).pipe(
          Scope.provide(scope),
          Effect.onError(() => Scope.close(scope, Exit.void)),
          Effect.mapError(failure(relay)),
        )
        yield* Ref.update(open, (held) => new Map([...held, [relay, { connection, scope }]]))
        return connection
      })
    const drop = (relay: string) =>
      Effect.flatMap(Ref.get(open), (held) =>
        Option.match(Option.fromNullishOr(held.get(relay)), {
          onNone: () => Effect.void,
          onSome: (entry) =>
            Effect.andThen(
              Scope.close(entry.scope, Exit.void),
              Ref.update(open, (current) => new Map([...current].filter(([key]) => key !== relay))),
            ),
        }),
      )
    const using = <A>(relay: string, use: (connection: RelayConnection) => Effect.Effect<A, RelayPortFailure>) => {
      const once = Effect.gen(function* () {
        const held = (yield* Ref.get(open)).get(relay)
        const connection = held === undefined ? yield* connect(relay) : held.connection
        return yield* use(connection).pipe(Effect.tapError(() => drop(relay)))
      })
      return Semaphore.withPermits(lock, 1)(once.pipe(Effect.retry({ times: 1, while: reconnectable })))
    }
    const port: RelayPort = {
      publish: (relay, event) =>
        using(relay, (connection) => Effect.mapError(connection.publish(event), failure(relay))).pipe(
          Effect.retry({
            schedule: Schedule.exponential(Duration.seconds(1)),
            times: 2,
            while: (error) => error.reason !== 'refused' && error.reason !== 'authFailed',
          }),
        ),
      query: (relay, filter: InboxFilter) =>
        using(relay, (connection) =>
          Effect.mapError(
            connection.query({ ...filter, kinds: [...filter.kinds], '#p': [...filter['#p']] }),
            failure(relay),
          ),
        ),
    }
    return port
  })

const databaseName = 'sidequest-rooms'
const storeName = 'state'
const encodeState = Schema.encodeSync(Schema.fromJsonString(RoomState))
const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(RoomState))

const request = <A>(make: () => IDBRequest<A>) =>
  Effect.callback<A, 'unavailable'>((resume) => {
    const made = make()
    made.addEventListener('success', () => resume(Effect.succeed(made.result)))
    made.addEventListener('error', () => resume(Effect.fail('unavailable')))
  })

const database = Effect.callback<IDBDatabase, 'unavailable'>((resume) => {
  const opening = indexedDB.open(databaseName, 1)
  opening.addEventListener('upgradeneeded', () => opening.result.createObjectStore(storeName))
  opening.addEventListener('success', () => resume(Effect.succeed(opening.result)))
  opening.addEventListener('error', () => resume(Effect.fail('unavailable')))
  opening.addEventListener('blocked', () => resume(Effect.fail('unavailable')))
}).pipe(Effect.timeout(Duration.seconds(3)))

/** IndexedDB access that may throw (private windows, blocked site data) or fail: either way, nothing is read or kept. */
const guarded = <A>(effect: () => Effect.Effect<A, unknown>) =>
  Effect.suspend(() => Effect.try({ try: effect, catch: () => 'unavailable' as const })).pipe(
    Effect.flatten,
    Effect.option,
  )

/**
 * The room state of `pubkey` in this browser's IndexedDB, as one record per key: decrypted messages included, which the
 * room panel says plainly. Where IndexedDB is refused it lives in memory for the tab's life.
 */
export const browserStore = (pubkey: string) =>
  Effect.gen(function* () {
    const memory = yield* Ref.make<RoomState>(emptyRoomState)
    const read = guarded(() =>
      Effect.flatMap(database, (db) =>
        request(() => db.transaction(storeName, 'readonly').objectStore(storeName).get(pubkey)),
      ),
    )
    const write = (state: RoomState) =>
      guarded(() =>
        Effect.flatMap(database, (db) =>
          request(() => db.transaction(storeName, 'readwrite').objectStore(storeName).put(encodeState(state), pubkey)),
        ),
      )
    const store: RoomStore = {
      load: Effect.gen(function* () {
        const kept = Option.flatMap(yield* read, decodeState)
        if (Option.isSome(kept)) yield* Ref.set(memory, kept.value)
        return yield* Ref.get(memory)
      }),
      save: (state) => Effect.andThen(Ref.set(memory, state), Effect.asVoid(write(state))),
    }
    return store
  })

/** The room state this browser keeps for `pubkey`, as it was left: nothing is read from a relay or decrypted. */
export const storedState = (pubkey: string): Effect.Effect<RoomState> =>
  Effect.flatMap(browserStore(pubkey), (store) => store.load)

/**
 * How many messages in the rooms of each job `me` has not seen: texts and private proposals by someone else, later than
 * the time `read` keeps for their room (the newest message the room panel last showed there). Jobs with none are left
 * out.
 */
export const unreadByJob = (
  state: RoomState,
  me: string,
  read: Readonly<Record<string, number>>,
): ReadonlyArray<UnreadOnJob> => {
  const jobOf = new Map(state.rooms.map((founding) => [founding.room, founding.job]))
  const counts = new Map<string, number>()
  state.messages
    .filter(
      (message) =>
        message.author !== me &&
        (Predicate.isTagged(message.act, 'Text') || Predicate.isTagged(message.act, 'Proposal')) &&
        message.createdAt > (read[message.room] ?? 0),
    )
    .forEach((message) => {
      const job = jobOf.get(message.room)
      if (job !== undefined) counts.set(job, (counts.get(job) ?? 0) + 1)
    })
  return [...counts].map(([job, count]) => ({ job, count }))
}

/** A member's rooms in this browser: over the pipe, the index's inbox relays, and IndexedDB. */
export const openRooms = (
  origin: string,
  signer: RoomSigner,
  inboxRelays: (pubkey: string) => Effect.Effect<ReadonlyArray<string>>,
) =>
  Effect.gen(function* () {
    const relays = yield* pipeRelays(origin, signer)
    const store = yield* browserStore(signer.publicKey)
    const decodeRelays = Schema.decodeUnknownOption(Schema.Array(RelayUrl))
    return yield* makeNip17Rooms(
      {
        signer,
        relays,
        store,
        directory: {
          inboxRelays: (pubkey) =>
            Effect.map(inboxRelays(pubkey), (urls) => Option.getOrElse(decodeRelays(urls), () => [])),
        },
      },
      defaultRoomOptions,
    ).pipe(Effect.provideService(Crypto.Crypto, webCrypto))
  })

type Transport = Effect.Success<ReturnType<typeof openRooms>>
type Failure = { readonly reason: RoomsFailure }

const kitFailed = (reason: RoomsFailure): Failure => ({ reason })

/** The room layer's refusal as the page names it. */
const refusalOf = (error: RoomRefused): Failure => {
  if (error.reason === 'notMember' || error.reason === 'badBody') return kitFailed(error.reason)
  if (error.reason !== 'signer') return kitFailed('failed')
  return kitFailed(error.signer === 'cannotDisclose' ? 'cannotDisclose' : 'signerRefused')
}

const decodeRoom = (room: string) =>
  Effect.mapError(Schema.decodeUnknownEffect(RoomId)(room), () => kitFailed('failed'))

/** A proposal carried privately in a room, read as the index would read it; none when it is not one. */
const privateProposalOf = (event: NostrEvent) =>
  Effect.option(parseSidequestEvent(jobProposal, event)).pipe(
    Effect.map(
      Option.map(({ event: verified, content }) => ({
        id: verified.id,
        author: verified.pubkey,
        title: content.terms.title,
        amount: content.terms.amount,
        asset: content.terms.asset,
        deliveryDeadline: content.terms.deliveryDeadline,
        validUntil: content.validUntil,
        event: JSON.stringify(verified),
      })),
    ),
  )

const noExtras = { maybeMember: Option.none<string>(), maybeProposal: Option.none() }

/** One message as the panel shows it. */
const lineOf = (message: RoomMessage): Effect.Effect<RoomLine> => {
  const base = {
    id: message.id,
    author: message.author,
    createdAt: message.createdAt,
    viaGateway: message.viaGateway,
    ...noExtras,
  }
  return Match.valueTags(message.act, {
    Text: ({ text }) => Effect.succeed({ ...base, act: 'text' as const, text: text ?? '' }),
    Add: ({ member }) =>
      Effect.succeed({ ...base, act: 'add' as const, text: '', maybeMember: Option.some<string>(member) }),
    Remove: ({ member }) =>
      Effect.succeed({ ...base, act: 'remove' as const, text: '', maybeMember: Option.some<string>(member) }),
    Proposal: ({ event }) =>
      Effect.map(privateProposalOf(event), (maybeProposal) => ({
        ...base,
        act: 'proposal' as const,
        text: '',
        maybeProposal,
      })),
  })
}

const snapshotOf = (transcript: Transcript): Effect.Effect<RoomSnapshot> =>
  Effect.map(Effect.forEach(transcript.messages, lineOf), (lines) => ({
    room: transcript.founding.room,
    bidder: transcript.founding.bidder,
    lines,
    members: transcript.membership.members,
    agents: [],
    dropped: transcript.dropped.length,
  }))

const invalid = () => kitFailed('failed')

/** The job's rooms for the person: the buyer's with each bidder, or a bidder's own; then one pass over the inbox. */
export const syncJob = (rooms: Transport, input: JobRooms): Effect.Effect<RoomsRead, Failure> =>
  Effect.gen(function* () {
    const job = yield* Effect.mapError(Schema.decodeUnknownEffect(EventId)(input.job), invalid)
    const buyer = yield* Effect.mapError(Schema.decodeUnknownEffect(PublicKey)(input.buyer), invalid)
    const bidders = yield* Effect.mapError(Schema.decodeUnknownEffect(Schema.Array(PublicKey))(input.bidders), invalid)
    const foundings = bidders.filter((bidder) => bidder !== buyer).map((bidder) => foundingOf(job, buyer, bidder))
    yield* Effect.forEach(foundings, (founding) => Effect.mapError(rooms.create(founding), refusalOf))
    const report = yield* rooms.poll
    // Rooms a poll joined count too: a bidder who only wrote privately has no public proposal to name them.
    const joined = (yield* rooms.rooms).filter(
      (held) => held.job === job && held.buyer === buyer && !foundings.some((known) => known.room === held.room),
    )
    const transcripts = yield* Effect.forEach([...foundings, ...joined], (founding) =>
      Effect.mapError(rooms.transcript(founding.room), refusalOf),
    )
    return {
      rooms: yield* Effect.forEach(transcripts, snapshotOf),
      relays: report.relays.map(({ relay, outcome }) => ({ relay, outcome })),
      noInbox: report.noInboxRelays,
      canDisclose: false,
    }
  })

/** Sends into a room; how many of its copies reached a relay. */
export const sendBody = (rooms: Transport, room: string, body: RoomBody): Effect.Effect<Delivered, Failure> =>
  Effect.gen(function* () {
    const sent = yield* Effect.mapError(rooms.send(yield* decodeRoom(room), body), refusalOf)
    const delivered = sent.deliveries.filter((delivery) => delivery.outcome === 'sent').length
    return { sent: delivered, total: sent.deliveries.length }
  })

/** A bidder's signed proposal into their room with the buyer, which opens here if it was not yet. */
export const sendProposalTo = (
  rooms: Transport,
  job: string,
  buyer: string,
  event: NostrEvent,
): Effect.Effect<Delivered, Failure> =>
  Effect.gen(function* () {
    const jobId = yield* Effect.mapError(Schema.decodeUnknownEffect(EventId)(job), invalid)
    const buyerKey = yield* Effect.mapError(Schema.decodeUnknownEffect(PublicKey)(buyer), invalid)
    const room = yield* Effect.mapError(rooms.create(foundingOf(jobId, buyerKey, rooms.me)), refusalOf)
    return yield* sendBody(rooms, room, { _tag: 'Proposal', event })
  })

/** One message's disclosure bundle as JSON. */
export const discloseJson = (rooms: Transport, room: string, message: string): Effect.Effect<string, Failure> =>
  Effect.gen(function* () {
    const id = yield* Effect.mapError(Schema.decodeUnknownEffect(EventId)(message), invalid)
    const bundle = yield* Effect.mapError(rooms.disclose(yield* decodeRoom(room), id), refusalOf)
    return JSON.stringify(bundle, null, 2)
  })

/** Forgets a room's messages in this browser. */
export const forgetRoom = (rooms: Transport, room: string): Effect.Effect<void, Failure> =>
  Effect.flatMap(decodeRoom(room), rooms.forget)

/** Signs the person's kind-10050 list and sends it to those relays. */
export const publishInbox = (rooms: Transport, relays: ReadonlyArray<string>): Effect.Effect<NostrEvent, Failure> =>
  Effect.gen(function* () {
    const urls = yield* Effect.mapError(Schema.decodeUnknownEffect(Schema.Array(RelayUrl))(relays), invalid)
    const report = yield* Effect.mapError(rooms.publishIdentity(urls), refusalOf)
    return report.event
  })

const parseJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))

/** A pasted disclosure, checked with nothing but its text: who wrote what and when; none when it proves nothing. */
export const checkPasted = (text: string): Option.Option<CheckedDisclosure> =>
  Option.map(Result.getSuccess(Result.flatMap(parseJson(text), verifyDisclosure)), (verified) => ({
    author: verified.author,
    createdAt: verified.rumor.created_at,
    text: verified.rumor.content,
    maybeRoom: Option.map(verified.maybeMessage, (message) => message.room),
  }))
