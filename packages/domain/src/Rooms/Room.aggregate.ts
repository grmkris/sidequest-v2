import * as Domain from '@alchemy.run/domain'
import { AccountId, Digest, JobId, RoomId, RoomKind, textDigest } from '@sidequest/protocol'
import { Effect, Predicate, Schema } from 'effect'
import { actingAgent, asPerson, asSystem, withScope } from '../Authority.ts'
import { NotPermitted } from '../NotPermitted.rejection.ts'
import { agentTurnLimit, Count, IdempotencyKey, Members, MessageSeq, rememberedKeys } from './Message.ts'
import { OpenRoom, roomIdFor, RoomOpened, WrongRoom } from './OpenRoom.command.ts'
import { AgentsPaused, PauseAgents } from './PauseAgents.command.ts'
import { AgentPaused, AgentTurnLimit, IdempotencyConflict, MessagePosted, PostMessage } from './PostMessage.command.ts'
import { AgentsResumed, ResumeAgents } from './ResumeAgents.command.ts'
import { RoomNotOpen } from './RoomNotOpen.rejection.ts'

/** A recent message, remembered by its author's idempotency key and a digest of its text, never the text itself. */
const Sent = Schema.Struct({ author: AccountId, key: IdempotencyKey, digest: Digest, seq: MessageSeq })

/**
 * An open room holds only what its decisions need, so it stays the same size however many messages are posted: the
 * last sequence number, the run of agent messages, whose agents are paused, and the latest {@link rememberedKeys}
 * idempotency keys. The messages themselves live in the events and the `RoomMessages` stream.
 */
const Open = Schema.TaggedStruct('Open', {
  job: JobId,
  kind: RoomKind,
  members: Members,
  lastSeq: Count,
  agentStreak: Count,
  paused: Schema.Array(AccountId),
  sent: Schema.Array(Sent).check(Schema.isMaxLength(rememberedKeys)),
})
const RoomState = Schema.Union([Schema.TaggedStruct('Unopened', {}), Open])
type RoomState = typeof RoomState.Type

const inOpenRoom = (state: RoomState, room: RoomId) =>
  Predicate.isTagged(state, 'Open') ? Effect.succeed(state) : Effect.fail(new RoomNotOpen({ room }))

const memberOf = (open: typeof Open.Type, account: AccountId) =>
  open.members.includes(account) ? Effect.void : Effect.fail(new NotPermitted({ account, required: 'member' }))

/** The open room and the member sending the command, who must be a person. */
const personHere = Effect.fnUntraced(function* (state: RoomState, room: RoomId) {
  const member = yield* asPerson()
  const open = yield* inOpenRoom(state, room)
  yield* memberOf(open, member)
  return { open, member }
})

/**
 * A private conversation about one job between its buyer and one counterpart. Members post text, and their agents may
 * too with `discuss`, but at most {@link agentTurnLimit} agent messages in a row, and never while their person has
 * paused them. Nothing said here changes the job.
 */
export class Room extends Domain.Aggregate('Room', {
  id: RoomId,
  state: RoomState,
  initial: { _tag: 'Unopened' },
  commands: [OpenRoom, PostMessage, PauseAgents, ResumeAgents],
  decide: {
    OpenRoom: Effect.fn(function* (state, { job, kind, buyer, counterpart }, { id }) {
      yield* asSystem()
      const expected = roomIdFor({ job, kind, counterpart })
      if (expected !== id) return yield* new WrongRoom({ expected })
      return Predicate.isTagged(state, 'Unopened') ? [new RoomOpened({ job, kind, members: [buyer, counterpart] })] : []
    }),
    PostMessage: Effect.fn(function* (state, { text, key }, { id, now }) {
      const author = yield* withScope('discuss', now)
      const agent = yield* actingAgent
      const open = yield* inOpenRoom(state, id)
      yield* memberOf(open, author)
      const digest = yield* textDigest(text)
      const sent = open.sent.find((message) => message.author === author && message.key === key)
      if (sent !== undefined)
        return sent.digest === digest ? [] : yield* new IdempotencyConflict({ key, seq: sent.seq })
      if (agent !== undefined && open.paused.includes(author)) return yield* new AgentPaused({ agent, member: author })
      if (agent !== undefined && open.agentStreak >= agentTurnLimit)
        return yield* new AgentTurnLimit({ consecutive: open.agentStreak, limit: agentTurnLimit })
      const message = {
        job: open.job,
        members: open.members,
        seq: open.lastSeq + 1,
        author,
        text,
        key,
        digest,
        agentStreak: agent === undefined ? 0 : open.agentStreak + 1,
      }
      return [new MessagePosted(agent === undefined ? message : { ...message, agent })]
    }),
    PauseAgents: Effect.fn(function* (state, _, { id }) {
      const { open, member } = yield* personHere(state, id)
      return open.paused.includes(member) ? [] : [new AgentsPaused({ member })]
    }),
    ResumeAgents: Effect.fn(function* (state, _, { id }) {
      const { open, member } = yield* personHere(state, id)
      return open.paused.includes(member) ? [new AgentsResumed({ member })] : []
    }),
  },
  evolve: {
    RoomOpened: (_, { job, kind, members }) =>
      Open.make({ job, kind, members, lastSeq: 0, agentStreak: 0, paused: [], sent: [] }),
    MessagePosted: (state, { seq, author, key, digest, agentStreak }) =>
      Predicate.isTagged(state, 'Open')
        ? {
            ...state,
            lastSeq: seq,
            agentStreak,
            sent: [...state.sent, { author, key, digest, seq }].slice(-rememberedKeys),
          }
        : state,
    AgentsPaused: (state, { member }) =>
      Predicate.isTagged(state, 'Open') ? { ...state, paused: [...state.paused, member] } : state,
    AgentsResumed: (state, { member }) =>
      Predicate.isTagged(state, 'Open')
        ? { ...state, paused: state.paused.filter((paused) => paused !== member) }
        : state,
  },
}) {}
