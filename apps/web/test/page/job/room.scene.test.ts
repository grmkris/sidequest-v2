import { AgentId, type RoomRef } from '@sidequest/protocol'
import { Option } from 'effect'
import type { Html } from 'foldkit'
import { Command, click, expect, given, label, role, scene, submit, text, type, withViewInputs } from 'foldkit/scene'
import { describe, test } from 'vitest'
import {
  DrawMessageKey,
  init,
  Message,
  type Model,
  PostMessage,
  ReadMessages,
  SetAgents,
  update,
} from '../../../src/page/job/Room.ts'
import { view } from '../../../src/page/job/RoomView.ts'
import { Problem } from '../../../src/Problem.ts'
import { ada, ben, benRoom, engagementRoom, job } from '../../Fixtures.ts'

const asAda = withViewInputs(view, { me: Option.some(ada) })()
/** The rooms render nothing for someone who is not a member; the scene needs an element to look in. */
const inPage = (model: Model, h: Html.HtmlBuilder<Message>) => h.div([], [asAda(model, h)])

const engagement: RoomRef = { id: engagementRoom, kind: 'engagement' }
const negotiation: RoomRef = { id: benRoom, kind: 'negotiation', bidder: ben }

const steps = (model: Model, messages: ReadonlyArray<Message>): Model =>
  messages.reduce((current, message) => update(current, message).model, model)

/** Ada's rooms, the working room open with its messages read. */
const opened = steps(init('en', job, true).model, [
  Message.SucceededListRooms({ rooms: [negotiation, engagement] }),
  Message.SucceededReadMessages({
    room: engagementRoom,
    messages: [
      { seq: 1, author: ada, text: 'Hello!' },
      { seq: 2, author: ben, agent: AgentId.make('agent_01JQ00000000000000000000A1'), text: 'Starting now.' },
    ],
    next: null,
  }),
])

describe('the rooms of a job', () => {
  test('opens the working room first and names who wrote each message', () => {
    scene(
      { update, view: inPage },
      given(opened),
      expect(role('button', { name: 'Working room' })).toHaveAttr('aria-pressed', 'true'),
      expect(text('You')).toExist(),
      expect(text('account …000BEN, through agent …0000A1')).toExist(),
      expect(text('Starting now.')).toExist(),
      click(role('button', { name: 'With account …000BEN' })),
      Command.resolve(
        ReadMessages({ room: benRoom, maybeAfter: Option.none() }),
        Message.SucceededReadMessages({ room: benRoom, messages: [], next: null }),
      ),
      expect(text(/No messages yet\./u)).toExist(),
    )
  })

  test('a failed send keeps the message’s key, so trying again cannot post it twice', () => {
    scene(
      { update, view: inPage },
      given(opened),
      type(label('Your message'), 'When can you start?'),
      submit(role('form')),
      Command.resolve(DrawMessageKey, Message.CompletedDrawMessageKey({ key: 'web-1' })),
      Command.resolve(
        PostMessage({ room: engagementRoom, text: 'When can you start?', key: 'web-1' }),
        Message.FailedPostMessage({ room: engagementRoom, problem: Problem.Unreachable() }),
      ),
      expect(role('alert')).toContainText('Sidequest did not answer.'),
      submit(role('form')),
      Command.resolve(
        PostMessage({ room: engagementRoom, text: 'When can you start?', key: 'web-1' }),
        Message.SucceededPostMessage({ room: engagementRoom }),
      ),
      expect(label('Your message')).toHaveValue(''),
      Command.resolve(
        ReadMessages({ room: engagementRoom, maybeAfter: Option.some(2) }),
        Message.SucceededReadMessages({
          room: engagementRoom,
          messages: [{ seq: 3, author: ada, text: 'When can you start?' }],
          next: null,
        }),
      ),
      expect(text('When can you start?')).toExist(),
    )
  })

  test('pauses the person’s own agents in the room', () => {
    scene(
      { update, view: inPage },
      given(opened),
      click(role('button', { name: 'Pause my agents here' })),
      Command.resolve(
        SetAgents({ room: engagementRoom, paused: true }),
        Message.SucceededSetAgents({ room: engagementRoom, paused: true }),
      ),
      expect(text('Your agents are paused in this room.')).toExist(),
    )
  })

  test('shows nothing to someone who is not a member', () => {
    scene(
      { update, view: inPage },
      given(update(init('en', job, true).model, Message.FailedListRooms({ problem: Problem.NotSignedIn() })).model),
      expect(role('heading', { name: 'Conversation' })).not.toExist(),
    )
  })
})
