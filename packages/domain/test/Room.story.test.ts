import { Story } from '@alchemy.run/domain/Story'
import { describe, it } from '@effect/vitest'
import { roomIdOf } from '@sidequest/protocol'
import { expect } from 'vitest'
import { CurrentActor } from '../src/CurrentActor.context.ts'
import { MissingScope } from '../src/MissingScope.rejection.ts'
import { NotPermitted } from '../src/NotPermitted.rejection.ts'
import { PersonRequired } from '../src/PersonRequired.rejection.ts'
import { OpenRoom, WrongRoom } from '../src/Rooms/OpenRoom.command.ts'
import { AgentsPaused, PauseAgents } from '../src/Rooms/PauseAgents.command.ts'
import { AgentPaused, AgentTurnLimit, IdempotencyConflict, PostMessage } from '../src/Rooms/PostMessage.command.ts'
import { AgentsResumed, ResumeAgents } from '../src/Rooms/ResumeAgents.command.ts'
import { RoomMessage, RoomMessages } from '../src/Rooms/RoomMessages.stream.ts'
import { RoomNotOpen } from '../src/Rooms/RoomNotOpen.rejection.ts'
import { SystemOnly } from '../src/SystemOnly.rejection.ts'
import {
  agentOf,
  alice,
  aliceAgent,
  bob,
  bobAgent,
  bobRoom,
  bobRoomId,
  bobRoomOpened,
  carol,
  jobId,
  messageInBobRoom,
  person,
  says,
  settlement,
  story,
} from './fixtures.ts'

const say = ({ text }: { readonly text: string }, key: string) => new PostMessage({ text, key })
const bobsAgent = agentOf(bob, bobAgent, ['discuss'])
const alicesAgent = agentOf(alice, aliceAgent, ['discuss'])

describe('a room', () => {
  it.effect('lets its members and their agents talk, numbering each message and logging it for reading', () =>
    story(
      Story.given(bobRoom, bobRoomOpened),
      Story.provide(CurrentActor, person(alice)),
      Story.when(bobRoom, say(says.ask, 'alice-1')),
      Story.then(bobRoom, messageInBobRoom(1, alice, says.ask, 'alice-1')),
      Story.provide(CurrentActor, bobsAgent),
      Story.when(bobRoom, say(says.answer, 'bob-1')),
      Story.then(bobRoom, messageInBobRoom(2, bob, says.answer, 'bob-1', { agent: bobAgent, agentStreak: 1 })),
      Story.streamed(
        RoomMessages,
        bobRoom,
        new RoomMessage({ seq: 1, author: alice, text: says.ask.text, members: [alice, bob] }),
        new RoomMessage({ seq: 2, author: bob, agent: bobAgent, text: says.answer.text, members: [alice, bob] }),
      ),
    ),
  )

  it.effect('refuses a room nobody opened, strangers, and agents without discuss', () =>
    story(
      Story.provide(CurrentActor, person(alice)),
      Story.when(bobRoom, say(says.ask, 'alice-1')),
      Story.rejected(new RoomNotOpen({ room: bobRoomId })),
      Story.given(bobRoom, bobRoomOpened),
      Story.provide(CurrentActor, person(carol)),
      Story.when(bobRoom, say(says.ask, 'carol-1')),
      Story.rejected(new NotPermitted({ account: carol, required: 'member' })),
      Story.when(bobRoom, new PauseAgents()),
      Story.rejected(new NotPermitted({ account: carol, required: 'member' })),
      Story.provide(CurrentActor, agentOf(bob, bobAgent, ['propose'])),
      Story.when(bobRoom, say(says.answer, 'bob-1')),
      Story.rejected(new MissingScope({ agent: bobAgent, scope: 'discuss' })),
      Story.then(bobRoom),
    ),
  )

  it.effect('refuses the seventh agent message in a row until a person posts', () =>
    story(
      Story.given(bobRoom, bobRoomOpened),
      // Six agent messages, the two sides' agents taking turns.
      ...[1, 2, 3, 4, 5, 6].flatMap((seq) => {
        const [actor, author, agent] = seq % 2 === 1 ? [bobsAgent, bob, bobAgent] : [alicesAgent, alice, aliceAgent]
        return [
          Story.provide(CurrentActor, actor),
          Story.when(bobRoom, say(says.ack, `agent-${seq}`)),
          Story.then(bobRoom, messageInBobRoom(seq, author, says.ack, `agent-${seq}`, { agent, agentStreak: seq })),
        ]
      }),
      Story.provide(CurrentActor, bobsAgent),
      Story.when(bobRoom, say(says.ack, 'agent-7')),
      Story.rejected(new AgentTurnLimit({ consecutive: 6, limit: 6 })),
      Story.provide(CurrentActor, alicesAgent),
      Story.when(bobRoom, say(says.ack, 'agent-7')),
      Story.rejected(new AgentTurnLimit({ consecutive: 6, limit: 6 })),
      Story.provide(CurrentActor, person(alice)),
      Story.when(bobRoom, say(says.ask, 'alice-1')),
      Story.then(bobRoom, messageInBobRoom(7, alice, says.ask, 'alice-1')),
      Story.provide(CurrentActor, bobsAgent),
      Story.when(bobRoom, say(says.ack, 'agent-7')),
      Story.then(bobRoom, messageInBobRoom(8, bob, says.ack, 'agent-7', { agent: bobAgent, agentStreak: 1 })),
    ),
  )

  it.effect('lets a person pause and resume only their own agents', () =>
    story(
      Story.given(bobRoom, bobRoomOpened),
      Story.provide(CurrentActor, person(alice)),
      Story.when(bobRoom, new PauseAgents()),
      Story.then(bobRoom, new AgentsPaused({ member: alice })),
      Story.when(bobRoom, new PauseAgents()),
      Story.then(bobRoom),
      Story.provide(CurrentActor, alicesAgent),
      Story.when(bobRoom, say(says.ack, 'agent-1')),
      Story.rejected(new AgentPaused({ agent: aliceAgent, member: alice })),
      Story.when(bobRoom, new ResumeAgents()),
      Story.rejected(new PersonRequired({ agent: aliceAgent })),
      Story.provide(CurrentActor, bobsAgent),
      Story.when(bobRoom, say(says.ack, 'agent-1')),
      Story.then(bobRoom, messageInBobRoom(1, bob, says.ack, 'agent-1', { agent: bobAgent, agentStreak: 1 })),
      Story.provide(CurrentActor, person(alice)),
      Story.when(bobRoom, new ResumeAgents()),
      Story.then(bobRoom, new AgentsResumed({ member: alice })),
      Story.when(bobRoom, new ResumeAgents()),
      Story.then(bobRoom),
      Story.provide(CurrentActor, alicesAgent),
      Story.when(bobRoom, say(says.ack, 'agent-1')),
      Story.then(bobRoom, messageInBobRoom(2, alice, says.ack, 'agent-1', { agent: aliceAgent, agentStreak: 2 })),
    ),
  )

  it.effect('posts a message once per author and idempotency key, and refuses the key for other text', () =>
    story(
      Story.given(bobRoom, bobRoomOpened),
      Story.provide(CurrentActor, person(alice)),
      Story.when(bobRoom, say(says.ask, 'k-1')),
      Story.then(bobRoom, messageInBobRoom(1, alice, says.ask, 'k-1')),
      Story.when(bobRoom, say(says.ask, 'k-1')),
      Story.then(bobRoom),
      Story.when(bobRoom, say(says.other, 'k-1')),
      Story.rejected(new IdempotencyConflict({ key: 'k-1', seq: 1 })),
      // Another author's key is their own.
      Story.provide(CurrentActor, person(bob)),
      Story.when(bobRoom, say(says.other, 'k-1')),
      Story.then(bobRoom, messageInBobRoom(2, bob, says.other, 'k-1')),
    ),
  )

  it.effect('remembers only the keys of its latest 32 messages, however many are posted', () =>
    story(
      Story.given(
        bobRoom,
        bobRoomOpened,
        ...Array.from({ length: 33 }, (_, index) => messageInBobRoom(index + 1, alice, says.ack, `m-${index + 1}`)),
      ),
      Story.provide(CurrentActor, person(alice)),
      Story.when(bobRoom, say(says.other, 'm-2')),
      Story.rejected(new IdempotencyConflict({ key: 'm-2', seq: 2 })),
      Story.when(bobRoom, say(says.other, 'm-1')),
      Story.then(bobRoom, messageInBobRoom(34, alice, says.other, 'm-1')),
      Story.state(bobRoom, (state) => {
        expect(state).toMatchObject({ _tag: 'Open', lastSeq: 34, agentStreak: 0, paused: [] })
        expect(state).toHaveProperty('sent.length', 32)
      }),
    ),
  )

  it.effect('is opened only by the system, and only under the id its job, kind and counterpart name', () =>
    story(
      Story.provide(CurrentActor, person(alice)),
      Story.when(bobRoom, new OpenRoom({ job: jobId, kind: 'negotiation', buyer: alice, counterpart: bob })),
      Story.rejected(new SystemOnly({ account: alice })),
      Story.provide(CurrentActor, settlement),
      Story.when(bobRoom, new OpenRoom({ job: jobId, kind: 'negotiation', buyer: alice, counterpart: carol })),
      Story.rejected(new WrongRoom({ expected: roomIdOf({ job: jobId, kind: 'negotiation', bidder: carol }) })),
      Story.when(bobRoom, new OpenRoom({ job: jobId, kind: 'engagement', buyer: alice, counterpart: bob })),
      Story.rejected(new WrongRoom({ expected: roomIdOf({ job: jobId, kind: 'engagement' }) })),
      Story.when(bobRoom, new OpenRoom({ job: jobId, kind: 'negotiation', buyer: alice, counterpart: bob })),
      Story.then(bobRoom, bobRoomOpened),
      Story.when(bobRoom, new OpenRoom({ job: jobId, kind: 'negotiation', buyer: alice, counterpart: bob })),
      Story.then(bobRoom),
    ),
  )
})
