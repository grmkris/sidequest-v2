import { it } from '@effect/vitest'
import { Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { EventId } from '../src/Event.ts'
import { publicKeyOf } from '../src/Keys.ts'
import { foundingOf, type RoomAct, type RoomMessage } from '../src/RoomMessage.ts'
import { compareMessages, transcriptOf } from '../src/RoomTranscript.ts'
import { agentKey, bidderKey, buyerKey, startSeconds, strangerKey } from './RoomWorld.ts'

const buyer = publicKeyOf(buyerKey)
const bidder = publicKeyOf(bidderKey)
const agent = publicKeyOf(agentKey)
const stranger = publicKeyOf(strangerKey)
const founding = foundingOf(Schema.decodeSync(EventId)('cd'.repeat(32)), buyer, bidder)

// Ids run against the clock, so an order that ignored the clock would show.
const idOf = (index: number) => Schema.decodeSync(EventId)((100 - index).toString(16).padStart(64, '0'))

const message = (index: number, author: RoomMessage['author'], clock: number, act: RoomAct): RoomMessage => ({
  room: founding.room,
  id: idOf(index),
  author,
  // Every message in the same second: only the clock and the id can order them.
  createdAt: startSeconds,
  clock,
  act,
  viaGateway: author === agent,
  recipients: [],
})

const text = (value: string): RoomAct => ({ _tag: 'Text', text: value })

/** A room with concurrent messages, an add, the agent speaking, a non-member, a remove, and the agent after it. */
const held: ReadonlyArray<RoomMessage> = [
  message(1, buyer, 1, text('a')),
  message(2, bidder, 1, text('b')),
  message(3, bidder, 2, { _tag: 'Add', member: agent }),
  message(4, agent, 3, text('agent')),
  message(5, stranger, 3, text('stranger')),
  message(6, buyer, 3, text('c')),
  message(7, agent, 4, { _tag: 'Add', member: stranger }),
  message(8, bidder, 5, { _tag: 'Remove', member: agent }),
  message(9, agent, 6, text('too late')),
  message(10, buyer, 6, { _tag: 'Remove', member: bidder }),
]

const ids = (messages: ReadonlyArray<RoomMessage>) => messages.map((kept) => kept.id)

describe('a room’s transcript', () => {
  test('orders by clock, then time, then id; keeps members, drops the rest with a reason', () => {
    const read = transcriptOf(founding, held)
    expect(ids(read.messages)).toEqual([2, 1, 3, 6, 4, 8].map(idOf))
    expect(read.dropped).toEqual([
      { id: idOf(5), reason: 'notMember' },
      { id: idOf(7), reason: 'notFounder' },
      { id: idOf(10), reason: 'founderFixed' },
      { id: idOf(9), reason: 'notMember' },
    ])
    expect(read.membership).toEqual({
      room: founding.room,
      founders: [buyer, bidder],
      members: [buyer, bidder].toSorted(),
      version: 2,
    })
  })

  it.prop(
    'the same messages in any arrival order give the same transcript',
    [Schema.Array(Schema.Int).check(Schema.isBetweenLength(held.length, held.length))],
    ([keys]) => {
      const arrived = held
        .map((kept, index) => ({ kept, key: keys[index] ?? 0 }))
        .toSorted((a, b) => a.key - b.key)
        .map(({ kept }) => kept)
      const twice = [...arrived, ...arrived.slice(0, 3)]
      return JSON.stringify(transcriptOf(founding, twice)) === JSON.stringify(transcriptOf(founding, held))
    },
  )

  test('the order is total over distinct messages', () => {
    const [first, second] = [message(11, buyer, 1, text('x')), message(12, buyer, 1, text('y'))]
    expect([compareMessages(first, second), compareMessages(second, first), compareMessages(first, first)]).toEqual([
      1, -1, 0,
    ])
  })
})
