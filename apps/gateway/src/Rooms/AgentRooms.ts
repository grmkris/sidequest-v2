import type { PublicKey } from '@sidequest/nostr'
import {
  defaultRoomOptions,
  localRoomSigner,
  makeNip17Rooms,
  type PollReport,
  type RoomFounding,
  type RoomMessage,
  type RoomRefused,
  type RoomState,
  type RoomTransport,
} from '@sidequest/nostr/rooms'
import { keyAuth } from '@sidequest/nostr/relay'
import { RelayUrl } from '@sidequest/nostr/vocabulary'
import { webCrypto } from '@sidequest/protocol'
import { nowSeconds } from '@sidequest/serving/Authorize'
import { Crypto, Effect, Match, Option, Predicate, Ref, Schema } from 'effect'
import { Core } from '../Core/Core.ts'
import { AgentKeys } from '../Keys/AgentKeys.ts'
import { acting, refusedByCore } from '../Mcp/Acting.ts'
import { RoomRefusalReason, RoomToolRefused } from '../Mcp/RoomTools.ts'
import type { Refused } from '../Mcp/Tools.ts'
import { AgentRoomState } from './AgentRoomState.ts'
import { RoomNetwork } from './RoomNetwork.ts'
import { consecutiveAgentMessages, maxConsecutiveAgentMessages, turnsLeft } from './TurnLimit.ts'

// The room tools' work: each call opens the agent's key, builds its rooms over the relays and its stored state, does
// its one thing, and stores the state again, stripped of every text. The agent's messages carry the gateway flag.

const refusedAs = (reason: RoomToolRefused['reason'], detail?: string) =>
  new RoomToolRefused({ reason, ...(detail === undefined ? {} : { detail }) })

const isRoomReason = Schema.is(RoomRefusalReason)

/** A tool's refusal as a room tool's. */
const fromTool = (refused: Refused) =>
  refusedAs(isRoomReason(refused.reason) ? refused.reason : 'CoreRefused', refused.detail ?? refused.core?.refusal)

/** The room layer's refusal as a room tool's. */
const fromRooms = (refused: RoomRefused) =>
  Match.value(refused.reason).pipe(
    Match.when('unknownRoom', () => refusedAs('UnknownRoom')),
    Match.when('notMember', () => refusedAs('NotMember')),
    Match.when('badBody', () => refusedAs('BadText')),
    Match.orElse((reason) => refusedAs('SignerFailed', refused.signer ?? reason)),
  )

const store = Effect.mapError(() => refusedAs('CoreUnavailable', 'The gateway’s store.'))

/** The calling agent past the grant gate (`discuss`) and not paused by its operator; `reads` for a tool that sends
 * nothing, which counts against the agent's calls but not its writes. */
const discussing = Effect.fnUntraced(function* (reads: boolean) {
  const admitted = yield* Effect.mapError(acting('discuss', reads), fromTool)
  const state = yield* AgentRoomState
  if (yield* store(state.paused(admitted.agent))) return yield* refusedAs('Paused')
  return admitted
})

/** What a poll that may not claim messages leaves out of the stored state: the messages it added, the wraps it
 * handled and how far it read each relay (`cursors` holds the cursors from before it), so the next poll reads the same
 * window again, opens those wraps again and finds the messages new. */
interface Unclaimed {
  readonly messages: ReadonlySet<string>
  readonly wraps: ReadonlySet<string>
  readonly cursors: RoomState['cursors']
}

const keyOf = (message: RoomMessage) => `${message.room}:${message.id}`

/** What `after` holds that `before` did not. */
const addedSince = (before: RoomState, after: RoomState): Unclaimed => {
  const held = new Set(before.messages.map(keyOf))
  const handled = new Set(before.seen.map((entry) => entry.wrap))
  return {
    messages: new Set(after.messages.map(keyOf).filter((key) => !held.has(key))),
    wraps: new Set(after.seen.map((entry) => entry.wrap).filter((wrap) => !handled.has(wrap))),
    cursors: before.cursors,
  }
}

/** The state as stored after a call that may not claim: without what its polls added (see {@link Unclaimed}). */
const withoutUnclaimed = (state: RoomState, unclaimed: ReadonlyArray<Unclaimed>): RoomState => ({
  ...state,
  messages: state.messages.filter((message) => !unclaimed.some((left) => left.messages.has(keyOf(message)))),
  seen: state.seen.filter((entry) => !unclaimed.some((left) => left.wraps.has(entry.wrap))),
  cursors: unclaimed[0]?.cursors ?? state.cursors,
})

/** The agent's rooms for one call, and the poll that call makes. */
interface CallRooms {
  readonly rooms: RoomTransport
  readonly poll: Effect.Effect<PollReport, RoomToolRefused>
}

/**
 * Runs `use` with the agent's rooms, and stores what they hold afterwards, even when `use` failed. Only a call that
 * `claims` (`read_room_messages`) stores the messages its polls found: the room layer answers a message as new once,
 * to the poll that first handles its wrap, so a poll by `list_rooms` or `send_room_message` that stored them would
 * take them from the next read. Those calls see every message while they run, and leave them for the read.
 */
const withRooms = <A>(
  agent: PublicKey,
  claims: boolean,
  use: (call: CallRooms) => Effect.Effect<A, RoomToolRefused, Core>,
) =>
  Effect.gen(function* () {
    const keys = yield* AgentKeys
    const network = yield* RoomNetwork
    const state = yield* AgentRoomState
    return yield* keys
      .withKey(agent, (key) =>
        Effect.gen(function* () {
          const held = yield* Ref.make(yield* store(state.load(agent)))
          const unclaimed = yield* Ref.make<ReadonlyArray<Unclaimed>>([])
          const rooms = yield* makeNip17Rooms(
            {
              signer: localRoomSigner(key, webCrypto),
              relays: network.port(keyAuth(key)),
              directory: { inboxRelays: network.inboxRelays },
              store: { load: Ref.get(held), save: (next) => Ref.set(held, next) },
            },
            { ...defaultRoomOptions, viaGateway: true },
          ).pipe(Effect.provideService(Crypto.Crypto, webCrypto))
          const poll = Effect.gen(function* () {
            const before = yield* Ref.get(held)
            const report = yield* rooms.poll
            if (report.noInboxRelays) return yield* refusedAs('NoInboxRelays')
            const after = yield* Ref.get(held)
            if (!claims) yield* Ref.update(unclaimed, (left) => [...left, addedSince(before, after)])
            return report
          })
          const outcome = yield* Effect.exit(use({ rooms, poll }))
          const kept = withoutUnclaimed(yield* Ref.get(held), yield* Ref.get(unclaimed))
          yield* store(state.save(agent, kept, yield* nowSeconds))
          return yield* outcome
        }),
      )
      .pipe(
        Effect.catchTags({
          KeyUnsealable: () => Effect.fail(refusedAs('KeyUnavailable')),
          Unavailable: () => Effect.fail(refusedAs('CoreUnavailable', 'The gateway’s store.')),
        }),
      )
  })

/** `list_rooms`: the agent's rooms on `job`, whose buyer is the job's buyer as the index shows it. */
export const listRooms = (job: string) =>
  Effect.gen(function* () {
    const { agent } = yield* discussing(true)
    const core = yield* Core
    const view = yield* core.job(job).pipe(Effect.mapError((error) => fromTool(refusedByCore(error))))
    if (Option.isNone(view)) return yield* refusedAs('UnknownJob')
    const buyer = view.value.buyer
    return yield* withRooms(agent, false, ({ rooms, poll }) =>
      Effect.gen(function* () {
        yield* poll
        const onJob = (yield* rooms.rooms).filter((founding) => founding.job === job && founding.buyer === buyer)
        const summaries = yield* Effect.forEach(onJob, (founding) =>
          Effect.map(Effect.mapError(rooms.transcript(founding.room), fromRooms), (read) => ({
            ...founding,
            members: read.membership.members,
            member: read.membership.members.includes(agent),
            messages: read.messages.length,
            turnsLeft: turnsLeft(read.messages),
          })),
        )
        return { rooms: summaries }
      }),
    )
  })

/** A message as the tool shows it: its act spelled out, its text when this call read it from the relays. */
const shown = (founding: RoomFounding, message: RoomMessage) => ({
  room: message.room,
  job: founding.job,
  id: message.id,
  author: message.author,
  createdAt: message.createdAt,
  clock: message.clock,
  viaGateway: message.viaGateway,
  ...Match.valueTags(message.act, {
    Text: ({ text }) => ({ kind: 'text' as const, ...(text === undefined ? {} : { text }) }),
    Add: ({ member }) => ({ kind: 'add' as const, member }),
    Remove: ({ member }) => ({ kind: 'remove' as const, member }),
    Proposal: ({ event }) => ({ kind: 'proposal' as const, proposal: event.id }),
  }),
})

const relaysOf = (report: PollReport) => report.relays.map(({ relay, outcome }) => ({ relay, outcome }))

/** `read_room_messages`: what arrived since the last read, once each, in each room's order. */
export const readRoomMessages = Effect.gen(function* () {
  const { agent } = yield* discussing(true)
  const read = yield* withRooms(agent, true, ({ rooms, poll }) =>
    Effect.gen(function* () {
      const report = yield* poll
      const foundings = new Map((yield* rooms.rooms).map((founding) => [founding.room, founding]))
      const messages = report.fresh.flatMap((message) =>
        Option.toArray(
          Option.map(Option.fromNullishOr(foundings.get(message.room)), (founding) => shown(founding, message)),
        ),
      )
      return { messages, relays: relaysOf(report) }
    }),
  )
  // Two calls that overlapped read the same messages from the relays; each answers only those it claimed first.
  const claimed = yield* store(
    (yield* AgentRoomState).claimReads(
      agent,
      read.messages.map((message) => message.id),
      yield* nowSeconds,
    ),
  )
  return { ...read, messages: read.messages.filter((message) => claimed.has(message.id)) }
})

/** `set_inbox_relays`: the agent's kind-10050 list, signed, sent to those relays and published through the core,
 * unless the index already knows one, which is kept. */
export const setInboxRelays = (asked: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { agent } = yield* discussing(false)
    const network = yield* RoomNetwork
    const known = yield* network.inboxRelays(agent)
    if (known.length > 0) return { relays: known, published: false }
    const relays = asked.flatMap((url) => (network.allows(url) ? decodeRelay(url) : []))
    if (relays.length !== asked.length) return yield* refusedAs('BadRelay')
    const core = yield* Core
    return yield* withRooms(agent, false, ({ rooms }) =>
      Effect.gen(function* () {
        const published = yield* Effect.mapError(rooms.publishIdentity(relays), fromRooms)
        yield* core.publish(published.event).pipe(Effect.mapError((error) => fromTool(refusedByCore(error))))
        return { relays, published: true }
      }),
    )
  })

const decodeRelay = (url: string) => Option.toArray(Schema.decodeUnknownOption(RelayUrl)(url))

/** `send_room_message`: the text to every member, unless gateway agents already sent six in a row. */
export const sendRoomMessage = (room: string, text: string) =>
  Effect.gen(function* () {
    const { agent } = yield* discussing(false)
    return yield* withRooms(agent, false, ({ rooms, poll }) =>
      Effect.gen(function* () {
        yield* poll
        const known = (yield* rooms.rooms).find((founding) => founding.room === room)
        if (known === undefined) return yield* refusedAs('UnknownRoom')
        const before = yield* Effect.mapError(rooms.transcript(known.room), fromRooms)
        if (consecutiveAgentMessages(before.messages) >= maxConsecutiveAgentMessages) {
          return yield* refusedAs('TurnLimit', 'A person in the room must write first.')
        }
        const sent = yield* Effect.mapError(rooms.send(known.room, { _tag: 'Text', text }), fromRooms)
        const after = yield* Effect.mapError(rooms.transcript(known.room), fromRooms)
        const members = [...new Set(sent.deliveries.map((delivery) => delivery.recipient))]
        const delivered = members.map((member) => {
          const copies = sent.deliveries.filter((delivery) => delivery.recipient === member)
          return {
            member,
            sent: copies.filter((delivery) => delivery.outcome === 'sent').length,
            relays: copies.filter((delivery) => !Predicate.isNull(delivery.relay)).length,
          }
        })
        return {
          room: known.room,
          message: sent.message.id,
          clock: sent.message.clock,
          turnsLeft: turnsLeft(after.messages),
          delivered,
        }
      }),
    )
  })
