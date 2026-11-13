import { Clock, Crypto, Effect, Option, Predicate, Ref, Schema, Semaphore } from 'effect'
import { type DisclosureBundle, discloseSeal } from './Disclosure.ts'
import type { EventId, NostrEvent } from './Event.ts'
import type { PublicKey } from './PublicKey.ts'
import { messagingRelaysTemplate, type RelayUrl } from './RelayList.ts'
import { type RoomBody, type RoomFounding, type RoomMessage, roomMessageOf, roomTemplate } from './RoomMessage.ts'
import { makeRumor } from './Rumor.ts'
import { type Opened, openWrap, type PollLimits, pollRelay, prunedSeen, type RelayPoll } from './RoomPoll.ts'
import type { InboxDirectory, RelayPort, RoomId, RoomState, RoomStore } from './RoomPorts.ts'
import { type Delivery, type SealRefused, sendCopies } from './RoomSend.ts'
import type { RoomSigner } from './RoomSigner.ts'
import { type Membership, nextClock, type Transcript, transcriptOf } from './RoomTranscript.ts'
import { bodyRefusal, ingest, withMessage } from './RoomState.ts'

// Rooms over NIP-17 (ADR-0004): the one implementation of `RoomTransport`. Nothing above this interface names NIP-17,
// so another protocol can take its place.

/** Why the room layer refused: no such room here, the member is not (or no longer) in it, only a founding member may
 * change who is, a founding member cannot be removed, the body is not one a room carries, the message is not held or
 * its seal was not kept, or the signer did not do its part (`signer` says why). */
export class RoomRefused extends Schema.TaggedError<RoomRefused>()('RoomRefused', {
  reason: Schema.Literals([
    'unknownRoom',
    'notFounding',
    'notMember',
    'notFounder',
    'founderFixed',
    'badBody',
    'unknownMessage',
    'sealNotKept',
    'signer',
  ]),
  signer: Schema.optionalKey(Schema.String),
}) {}

/** How one message went out: the message as the room now holds it, and every copy's fate per relay. */
export interface SendReport {
  readonly message: RoomMessage
  readonly deliveries: ReadonlyArray<Delivery>
}

/** One polling pass: each inbox relay's part, rooms joined, messages new to the transcripts, wraps opened (none twice:
 * handled wraps are remembered in the store), wraps that did not open, and wraps the signer would not open now.
 * `noInboxRelays` when the member has no inbox relay to read. */
export interface PollReport {
  readonly relays: ReadonlyArray<RelayPoll>
  readonly joined: ReadonlyArray<RoomId>
  readonly fresh: ReadonlyArray<RoomMessage>
  readonly opened: number
  readonly unopenable: number
  readonly deferred: number
  readonly noInboxRelays: boolean
}

/** The member's kind-10050 list as signed, and what each relay answered. */
export interface IdentityReport {
  readonly event: NostrEvent
  readonly acks: ReadonlyArray<{ readonly relay: RelayUrl; readonly outcome: Delivery['outcome'] }>
}

/** A member's rooms (ADR-0004, decision 2): publish identity, create, add, remove, send, poll, members, disclose. */
export interface RoomTransport {
  readonly me: PublicKey
  readonly publishIdentity: (relays: ReadonlyArray<RelayUrl>) => Effect.Effect<IdentityReport, RoomRefused>
  readonly create: (founding: RoomFounding) => Effect.Effect<RoomId, RoomRefused>
  readonly add: (room: RoomId, member: PublicKey) => Effect.Effect<SendReport, RoomRefused>
  readonly remove: (room: RoomId, member: PublicKey) => Effect.Effect<SendReport, RoomRefused>
  readonly send: (room: RoomId, body: RoomBody) => Effect.Effect<SendReport, RoomRefused>
  readonly poll: Effect.Effect<PollReport>
  readonly members: (room: RoomId) => Effect.Effect<Membership, RoomRefused>
  readonly transcript: (room: RoomId) => Effect.Effect<Transcript, RoomRefused>
  readonly rooms: Effect.Effect<ReadonlyArray<RoomFounding>>
  readonly forget: (room: RoomId) => Effect.Effect<void>
  readonly disclose: (room: RoomId, message: EventId) => Effect.Effect<DisclosureBundle, RoomRefused>
}

/** How a member's rooms behave; see {@link PollLimits}. `viaGateway` marks every message as a gateway agent's, and
 * `maxRelaysPerRecipient` bounds the relays one copy goes to. */
export interface RoomOptions extends PollLimits {
  readonly viaGateway: boolean
  readonly maxRelaysPerRecipient: number
}

/** Two days and fifteen minutes of look-back (NIP-59's backdating and some clock skew), pages of 100, at most 20. */
export const defaultRoomOptions: RoomOptions = {
  lookBackSeconds: 2 * 24 * 60 * 60 + 15 * 60,
  pageSize: 100,
  maxPages: 20,
  viaGateway: false,
  maxRelaysPerRecipient: 4,
}

const refused = (reason: RoomRefused['reason']) => new RoomRefused({ reason })
const sealFailed = (error: SealRefused) =>
  new RoomRefused({ reason: 'signer', ...(error.signer === undefined ? {} : { signer: error.signer }) })
const nowSeconds = Effect.map(Clock.currentTimeMillis, (millis) => Math.floor(millis / 1000))

/** What a member's rooms run on: its ports, options, state and the helpers every operation shares. */
interface Context {
  readonly ports: RoomPorts
  readonly options: RoomOptions
  readonly me: PublicKey
  readonly crypto: Crypto.Crypto
  readonly state: Ref.Ref<RoomState>
  readonly commit: (next: RoomState) => Effect.Effect<void>
  readonly relaysOf: (pubkey: PublicKey) => Effect.Effect<ReadonlyArray<RelayUrl>>
  readonly held: (
    room: RoomId,
  ) => Effect.Effect<{ readonly founding: RoomFounding; readonly current: RoomState }, RoomRefused>
}

/** The ports a member's rooms run on. */
export interface RoomPorts {
  readonly signer: RoomSigner
  readonly relays: RelayPort
  readonly directory: InboxDirectory
  readonly store: RoomStore
}

/** Who receives a message: every member but the sender, and, for an add, the member added. */
const recipientsOf = (me: PublicKey, membership: Membership, body: RoomBody) => {
  const audience = Predicate.isTagged(body, 'Add') ? [...membership.members, body.member] : membership.members
  return [...new Set(audience)].filter((member) => member !== me)
}

const sendWith = (context: Context) => (room: RoomId, body: RoomBody) =>
  Effect.gen(function* () {
    const { ports, me } = context
    const { founding, current } = yield* context.held(room)
    const held = current.messages.filter((message) => message.room === room)
    const { membership } = transcriptOf(founding, held)
    const refusal = bodyRefusal(me, membership, body)
    if (Option.isSome(refusal)) return yield* refused(refusal.value)
    const now = yield* nowSeconds
    const recipients = recipientsOf(me, membership, body)
    const { viaGateway } = context.options
    const rumor = makeRumor(
      roomTemplate({ founding, body, clock: nextClock(held), recipients, viaGateway, createdAt: now }),
      me,
    )
    const targets = yield* Effect.forEach([...recipients, me], (recipient) =>
      Effect.map(context.relaysOf(recipient), (relays) => ({ recipient, relays })),
    )
    const sent = yield* sendCopies({ signer: ports.signer, relays: ports.relays }, rumor, targets, now).pipe(
      Effect.mapError(sealFailed),
      Effect.provideService(Crypto.Crypto, context.crypto),
    )
    const message = yield* Option.match(roomMessageOf(rumor, sent.ownSeal), {
      onNone: () => Effect.fail(refused('badBody')),
      onSome: Effect.succeed,
    })
    yield* context.commit(withMessage(current, message, { wrap: sent.ownWrap.id, at: sent.ownWrap.created_at }))
    return { message, deliveries: sent.deliveries } satisfies SendReport
  })

const readRelays = (context: Context, relays: ReadonlyArray<RelayUrl>, current: RoomState) =>
  Effect.forEach(
    relays,
    (relay) =>
      pollRelay(
        context.ports.relays,
        relay,
        context.me,
        Option.fromNullishOr(current.cursors.find((cursor) => cursor.relay === relay)),
        context.options,
      ),
    { concurrency: 2 },
  )

const pollWith = (context: Context): Effect.Effect<PollReport> =>
  Effect.gen(function* () {
    const relays = yield* context.relaysOf(context.me)
    if (relays.length === 0) {
      return { relays: [], joined: [], fresh: [], opened: 0, unopenable: 0, deferred: 0, noInboxRelays: true }
    }
    const startedAt = yield* nowSeconds
    const current = yield* Ref.get(context.state)
    const read = yield* readRelays(context, relays, current)
    const seen = new Set(current.seen.map((entry) => entry.wrap))
    const wraps = [...new Map(read.flatMap((part) => part.wraps).map((wrap) => [wrap.id, wrap])).values()]
    const outcomes = yield* Effect.forEach(
      wraps.filter((wrap) => !seen.has(wrap.id)),
      (wrap) =>
        Effect.map(openWrap(context.ports.signer, wrap), (outcome): readonly [NostrEvent, Opened] => [wrap, outcome]),
    )
    const complete = read.filter((part) => part.report.outcome === 'complete').map((part) => part.report.relay)
    const ingested = ingest(current, context.me, outcomes, complete, startedAt)
    const { lookBackSeconds } = context.options
    yield* context.commit({
      ...ingested.state,
      seen: prunedSeen(ingested.state.seen, ingested.state.cursors, relays, lookBackSeconds),
    })
    return {
      relays: read.map((part) => part.report),
      joined: ingested.joined,
      fresh: ingested.fresh,
      opened: outcomes.filter(([, outcome]) => Predicate.isTagged(outcome, 'Message')).length,
      unopenable: outcomes.filter(([, outcome]) => Predicate.isTagged(outcome, 'Handled')).length,
      deferred: outcomes.filter(([, outcome]) => Predicate.isTagged(outcome, 'Deferred')).length,
      noInboxRelays: false,
    }
  })

const publishIdentityWith = (context: Context) => (relays: ReadonlyArray<RelayUrl>) =>
  Effect.gen(function* () {
    const template = messagingRelaysTemplate(relays, yield* nowSeconds)
    const event = yield* Effect.mapError(context.ports.signer.signEvent(template), signerRefused)
    const acks = yield* Effect.forEach(relays, (relay) =>
      Effect.match(context.ports.relays.publish(relay, event), {
        onSuccess: (ack) => ({ relay, outcome: ack.accepted ? ('sent' as const) : ('refused' as const) }),
        onFailure: (failure) => ({ relay, outcome: failure.reason }),
      }),
    )
    return { event, acks } satisfies IdentityReport
  })

const createWith = (context: Context) => (founding: RoomFounding) =>
  Effect.gen(function* () {
    if (founding.buyer !== context.me && founding.bidder !== context.me) return yield* refused('notFounding')
    const current = yield* Ref.get(context.state)
    if (!current.rooms.some((held) => held.room === founding.room)) {
      yield* context.commit({ ...current, rooms: [...current.rooms, founding] })
    }
    return founding.room
  })

const forgetWith = (context: Context) => (room: RoomId) =>
  Effect.flatMap(Ref.get(context.state), (current) =>
    context.commit({
      ...current,
      rooms: current.rooms.filter((held) => held.room !== room),
      messages: current.messages.filter((message) => message.room !== room),
    }),
  )

const discloseWith = (context: Context) => (room: RoomId, id: EventId) =>
  Effect.gen(function* () {
    const { current } = yield* context.held(room)
    const message = current.messages.find((held) => held.room === room && held.id === id)
    if (message === undefined) return yield* refused('unknownMessage')
    if (message.seal === undefined) return yield* refused('sealNotKept')
    return yield* Effect.mapError(discloseSeal(context.ports.signer, message.seal), signerRefused)
  })

const signerRefused = (error: { readonly reason: string }) =>
  new RoomRefused({ reason: 'signer', signer: error.reason })

/** The rooms of the member `ports.signer` signs for, over its relays, directory and store. Operations that change the
 * state run one at a time. */
export const makeNip17Rooms = Effect.fnUntraced(function* (
  ports: RoomPorts,
  options: RoomOptions = defaultRoomOptions,
) {
  const state = yield* Ref.make(yield* ports.store.load)
  const lock = yield* Semaphore.make(1)
  const exclusive = Semaphore.withPermits(lock, 1)
  const context: Context = {
    ports,
    options,
    me: ports.signer.publicKey,
    crypto: yield* Crypto.Crypto,
    state,
    commit: (next) => Effect.andThen(Ref.set(state, next), ports.store.save(next)),
    relaysOf: (pubkey) =>
      Effect.map(ports.directory.inboxRelays(pubkey), (relays) => relays.slice(0, options.maxRelaysPerRecipient)),
    held: (room) =>
      Effect.flatMap(Ref.get(state), (current) =>
        Option.match(Option.fromNullishOr(current.rooms.find((founding) => founding.room === room)), {
          onNone: () => Effect.fail(refused('unknownRoom')),
          onSome: (founding) => Effect.succeed({ founding, current }),
        }),
      ),
  }
  const send = (room: RoomId, body: RoomBody) => exclusive(sendWith(context)(room, body))
  const transcript = (room: RoomId) =>
    Effect.map(context.held(room), ({ founding, current }) => transcriptOf(founding, current.messages))
  return {
    me: context.me,
    publishIdentity: publishIdentityWith(context),
    create: (founding) => exclusive(createWith(context)(founding)),
    add: (room, member) => send(room, { _tag: 'Add', member }),
    remove: (room, member) => send(room, { _tag: 'Remove', member }),
    send,
    poll: exclusive(pollWith(context)),
    members: (room) => Effect.map(transcript(room), (read) => read.membership),
    transcript,
    rooms: Effect.map(Ref.get(state), (current) => current.rooms),
    forget: (room) => exclusive(forgetWith(context)(room)),
    disclose: discloseWith(context),
  } satisfies RoomTransport
})
