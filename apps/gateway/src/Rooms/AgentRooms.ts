import type { PublicKey } from '@sidequest/nostr'
import {
  defaultRoomOptions,
  localRoomSigner,
  makeNip17Rooms,
  type PollReport,
  type RoomFounding,
  type RoomMessage,
  type RoomRefused,
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

/** Runs `use` with the agent's rooms, and stores what they hold afterwards, even when `use` failed. */
const withRooms = <A>(agent: PublicKey, use: (rooms: RoomTransport) => Effect.Effect<A, RoomToolRefused, Core>) =>
  Effect.gen(function* () {
    const keys = yield* AgentKeys
    const network = yield* RoomNetwork
    const state = yield* AgentRoomState
    return yield* keys
      .withKey(agent, (key) =>
        Effect.gen(function* () {
          const held = yield* Ref.make(yield* store(state.load(agent)))
          const rooms = yield* makeNip17Rooms(
            {
              signer: localRoomSigner(key, webCrypto),
              relays: network.port(keyAuth(key)),
              directory: { inboxRelays: network.inboxRelays },
              store: { load: Ref.get(held), save: (next) => Ref.set(held, next) },
            },
            { ...defaultRoomOptions, viaGateway: true },
          ).pipe(Effect.provideService(Crypto.Crypto, webCrypto))
          const outcome = yield* Effect.exit(use(rooms))
          yield* store(state.save(agent, yield* Ref.get(held), yield* nowSeconds))
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

const polled = (rooms: RoomTransport) =>
  Effect.flatMap(rooms.poll, (report) =>
    report.noInboxRelays ? Effect.fail(refusedAs('NoInboxRelays')) : Effect.succeed(report),
  )

/** `list_rooms`: the agent's rooms on `job`, whose buyer is the job's buyer as the index shows it. */
export const listRooms = (job: string) =>
  Effect.gen(function* () {
    const { agent } = yield* discussing(true)
    const core = yield* Core
    const view = yield* core.job(job).pipe(Effect.mapError((error) => fromTool(refusedByCore(error))))
    if (Option.isNone(view)) return yield* refusedAs('UnknownJob')
    const buyer = view.value.buyer
    return yield* withRooms(agent, (rooms) =>
      Effect.gen(function* () {
        yield* polled(rooms)
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
  const read = yield* withRooms(agent, (rooms) =>
    Effect.gen(function* () {
      const report = yield* polled(rooms)
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
    return yield* withRooms(agent, (rooms) =>
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
    return yield* withRooms(agent, (rooms) =>
      Effect.gen(function* () {
        yield* polled(rooms)
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
