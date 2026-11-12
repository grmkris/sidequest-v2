import { Option } from 'effect'
import { AsyncData } from 'foldkit'
import { Command, given, message, model, story } from 'foldkit/story'
import { describe, expect, test } from 'vitest'
import { init, Message, ReadMessages, update } from '../../../src/page/job/Room.ts'
import { ada, engagementRoom, job } from '../../Fixtures.ts'

const listed = update(
  init('en', job, true).model,
  Message.SucceededListRooms({ rooms: [{ id: engagementRoom, kind: 'engagement' }] }),
)

describe('following a room', () => {
  test('reads only for someone who may be a member', () => {
    story(
      update,
      given(init('en', job, false).model),
      model((rooms) => expect(AsyncData.isIdle(rooms.rooms)).toBe(true)),
      message(Message.TickedRoom()),
      Command.expectNone(),
    )
    story(update, given(listed.model), message(Message.TickedRoom()), Command.expectNone())
  })

  test('reads page after page until the server says there is no more', () => {
    story(
      update,
      given(listed.model),
      message(
        Message.SucceededReadMessages({
          room: engagementRoom,
          messages: [{ seq: 1, author: ada, text: 'Hi' }],
          next: 1,
        }),
      ),
      Command.expectExact(ReadMessages({ room: engagementRoom, maybeAfter: Option.some(1) })),
      Command.resolve(ReadMessages, Message.SucceededReadMessages({ room: engagementRoom, messages: [], next: null })),
      Command.expectNone(),
      model((rooms) => expect(Option.map(rooms.maybeOpen, (open) => open.messages.length)).toEqual(Option.some(1))),
      message(Message.TickedRoom()),
      Command.expectExact(ReadMessages({ room: engagementRoom, maybeAfter: Option.some(1) })),
      Command.resolve(ReadMessages, Message.SucceededReadMessages({ room: engagementRoom, messages: [], next: null })),
    )
  })
})
