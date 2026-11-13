import { Option } from 'effect'
import { Command, given, message, model, story } from 'foldkit/story'
import { describe, expect, test } from 'vitest'
import {
  Disclose,
  Evidence,
  ForgetRoom,
  init,
  Message,
  type Model,
  Panel,
  SendText,
  Sending,
  SyncRooms,
  update,
} from '../../../src/page/job/room/Room.ts'
import type { RoomsRead } from '../../../src/Rooms.ts'
import { bidderKey, buyerKey, requestId } from '../../Fixtures.ts'

const target = { job: requestId, buyer: buyerKey, bidders: [bidderKey] }
const room = 'ab'.repeat(32)
const read: RoomsRead = {
  rooms: [
    {
      room,
      bidder: bidderKey,
      lines: [
        {
          id: 'cd'.repeat(32),
          author: bidderKey,
          createdAt: 1_800_000_000,
          act: 'text',
          text: 'Hello <b>there</b>',
          maybeMember: Option.none(),
          maybeProposal: Option.none(),
          viaGateway: false,
        },
      ],
      members: [buyerKey, bidderKey],
      agents: [],
      dropped: 0,
    },
  ],
  relays: [{ relay: 'wss://inbox.example', outcome: 'complete' }],
  noInbox: false,
}

const fresh: Model = init('en')

/** The panel opened and its first pass read the rooms. */
const opened = [
  message(Message.ClickedOpen({ target })),
  Command.expectExact(SyncRooms({ target })),
  Command.resolve(SyncRooms, Message.SucceededSync({ read })),
]

describe('the room panel', () => {
  test('opens with one pass, and polls only while open, one pass at a time', () =>
    story(
      update,
      given(fresh),
      message(Message.TickedPoll()),
      model((panel) => expect(panel.polling).toBe(false)),
      ...opened,
      model((panel) => {
        expect(Panel.guards.Open(panel.panel)).toBe(true)
        expect(panel.maybeRead).toEqual(Option.some(read))
      }),
      message(Message.TickedPoll()),
      Command.expectExact(SyncRooms({ target })),
      Command.resolve(SyncRooms, Message.SucceededSync({ read })),
      message(Message.ClickedClose()),
      message(Message.TickedPoll()),
      model((panel) => expect([Panel.guards.Closed(panel.panel), panel.polling]).toEqual([true, false])),
    ))

  test('starts no second pass or send while one is under way', () => {
    const polling: Model = { ...init('en'), panel: Panel.Open({ target }), polling: true }
    expect(update(polling, Message.TickedPoll()).commands ?? []).toEqual([])
    const sending: Model = { ...polling, maybeRead: Option.some(read), draft: 'again', sending: Sending.Sending() }
    expect(update(sending, Message.SubmittedMessage()).commands ?? []).toEqual([])
  })

  test('sends a message into the shown room, then reads again and says how far it went', () =>
    story(
      update,
      given(fresh),
      ...opened,
      message(Message.UpdatedDraft({ value: 'Can you start Monday?' })),
      message(Message.SubmittedMessage()),
      Command.expectExact(SendText({ room, text: 'Can you start Monday?' })),
      Command.resolve(SendText, Message.SucceededSend({ delivered: { sent: 3, total: 4 } })),
      Command.expectExact(SyncRooms({ target })),
      model((panel) => {
        expect(panel.draft).toBe('')
        expect(panel.sending).toEqual(Sending.Sent({ delivered: { sent: 3, total: 4 } }))
      }),
      Command.resolve(SyncRooms, Message.SucceededSync({ read })),
    ))

  test('refuses an empty message and one over 5000 characters, counting characters, not code units', () =>
    story(
      update,
      given(fresh),
      ...opened,
      message(Message.UpdatedDraft({ value: '   ' })),
      message(Message.SubmittedMessage()),
      message(Message.UpdatedDraft({ value: 'x'.repeat(5001) })),
      message(Message.SubmittedMessage()),
      model((panel) => expect(panel.sending).toEqual(Sending.Writing())),
      // 5000 emoji are 10000 UTF-16 code units, and still within the limit.
      message(Message.UpdatedDraft({ value: '🙂'.repeat(5000) })),
      message(Message.SubmittedMessage()),
      Command.expectExact(SendText({ room, text: '🙂'.repeat(5000) })),
      Command.resolve(SendText, Message.FailedSend({ reason: 'failed' })),
      model((panel) => expect(panel.sending).toEqual(Sending.Failed({ reason: 'failed' }))),
    ))

  test('an extension without NIP-44 makes the panel unavailable, and says why', () =>
    story(
      update,
      given(fresh),
      message(Message.ClickedOpen({ target })),
      Command.expectExact(SyncRooms({ target })),
      Command.resolve(SyncRooms, Message.FailedSync({ reason: 'noNip44' })),
      model((panel) => expect(panel.panel).toEqual(Panel.Unavailable({ reason: 'noNip44' }))),
      message(Message.TickedPoll()),
      model((panel) => expect(panel.polling).toBe(false)),
    ))

  test('a relay that fails keeps the panel open with its problem shown', () =>
    story(
      update,
      given(fresh),
      ...opened,
      message(Message.TickedPoll()),
      Command.resolve(SyncRooms, Message.FailedSync({ reason: 'failed' })),
      model((panel) => {
        expect(Panel.guards.Open(panel.panel)).toBe(true)
        expect(panel.maybeProblem).toEqual(Option.some('failed'))
      }),
    ))

  test('prepares one message’s evidence, and forgets a room only once the person confirms', () =>
    story(
      update,
      given(fresh),
      ...opened,
      message(Message.ClickedDisclose({ room, message: 'cd'.repeat(32) })),
      Command.expectExact(Disclose({ room, message: 'cd'.repeat(32) })),
      Command.resolve(Disclose, Message.SucceededDisclose({ message: 'cd'.repeat(32), json: '{}' })),
      model((panel) => expect(panel.evidence).toEqual(Evidence.Ready({ message: 'cd'.repeat(32), json: '{}' }))),
      message(Message.ClickedForget({ room })),
      message(Message.ClickedKeep()),
      message(Message.ClickedForget({ room })),
      message(Message.ClickedConfirmForget()),
      Command.expectExact(ForgetRoom({ room })),
      Command.resolve(ForgetRoom, Message.CompletedForget()),
      Command.expectExact(SyncRooms({ target })),
      Command.resolve(SyncRooms, Message.SucceededSync({ read: { ...read, rooms: [] } })),
      model((panel) => expect(Option.map(panel.maybeRead, (held) => held.rooms)).toEqual(Option.some([]))),
    ))
})
