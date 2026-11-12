import { type JobId, Message, MessageSeq, RoomRef, roomIdOf } from '@sidequest/protocol'
import { Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { buyerViewOf, named, postJob, propose } from './Hire.ts'
import { ada, ben, bodyOf, cy, eventually, type Person, type Reply, withApi } from './HttpWorld.ts'

// Rooms over HTTP: which a person is in comes from their view of the job; messages are read from the room's
// `RoomMessages` stream, whose `validate` admits only its members.

const Rooms = Schema.Struct({ rooms: Schema.Array(RoomRef) })
const Messages = Schema.Struct({ messages: Schema.Array(Message), next: Schema.NullOr(MessageSeq) })
const roomsOf = (reply: Reply) => bodyOf(Rooms, reply).rooms
const messagesOf = (reply: Reply) => bodyOf(Messages, reply)
const roomsFor = (person: Person, job: JobId) => person.get(`/api/jobs/${job}/rooms`)

/** A job Ada posted and Ben proposed on, once his negotiation room has opened. */
const negotiated = async (buyer: Person, bidder: Person) => {
  const job = await postJob(buyer)
  await propose(bidder, job)
  const room = roomIdOf({ job, kind: 'negotiation', bidder: bidder.account })
  await eventually(
    () => buyer.post(`/api/rooms/${room}/messages`, { text: 'Welcome.', key: 'welcome' }),
    ({ status }) => status === 204,
  )
  return { job, room }
}

describe('the rooms API', () => {
  test('lists the rooms each member is in, a negotiation per bidder, and the engagement once awarded', () =>
    withApi(async ({ signIn }) => {
      const buyer = await signIn(ada)
      const bidder = await signIn(ben)
      const stranger = await signIn(cy)
      const { job, room } = await negotiated(buyer, bidder)
      const negotiation = { id: room, kind: 'negotiation', bidder: bidder.account }
      expect(roomsOf(await roomsFor(buyer, job))).toEqual([negotiation])
      expect(roomsOf(await roomsFor(bidder, job))).toEqual([negotiation])
      expect(roomsOf(await roomsFor(stranger, job))).toEqual([])
      const [offer] = (await buyerViewOf(buyer, job)).proposals
      if (offer === undefined) throw new Error('No proposal arrived')
      await buyer.post(`/api/jobs/${job}/acceptance`, named(offer))
      const engagement = { id: roomIdOf({ job, kind: 'engagement' }), kind: 'engagement' }
      const awarded = await eventually(
        () => roomsFor(bidder, job),
        (reply) => roomsOf(reply).length === 2,
      )
      expect(roomsOf(awarded)).toEqual([negotiation, engagement])
      expect(roomsOf(await roomsFor(buyer, job))).toEqual([negotiation, engagement])
    }))

  test('posts a message once per idempotency key, and shows it to the room’s members only', () =>
    withApi(async ({ signIn }) => {
      const buyer = await signIn(ada)
      const bidder = await signIn(ben)
      const stranger = await signIn(cy)
      const { job, room } = await negotiated(buyer, bidder)
      const ask = { text: 'Can you start on Monday?', key: 'ask-1' }
      expect((await buyer.post(`/api/rooms/${room}/messages`, ask)).status).toBe(204)
      expect((await buyer.post(`/api/rooms/${room}/messages`, ask)).status).toBe(204)
      expect(await buyer.post(`/api/rooms/${room}/messages`, { ...ask, text: 'Tuesday?' })).toMatchObject({
        status: 409,
        body: { reason: 'IdempotencyConflict', evidence: { key: 'ask-1', seq: 2 } },
      })
      const read = await eventually(
        () => bidder.get(`/api/rooms/${room}/messages`),
        (reply) => messagesOf(reply).messages.length === 2,
      )
      expect(messagesOf(read)).toEqual({
        messages: [
          { seq: 1, author: buyer.account, text: 'Welcome.' },
          { seq: 2, author: buyer.account, text: ask.text },
        ],
        next: null,
      })
      expect(await stranger.get(`/api/rooms/${room}/messages`)).toMatchObject({
        status: 403,
        body: { reason: 'NotPermitted', evidence: { required: 'member' } },
      })
      expect(await stranger.post(`/api/rooms/${room}/messages`, ask)).toMatchObject({ status: 403 })
      const unopened = roomIdOf({ job, kind: 'negotiation', bidder: stranger.account })
      expect(await stranger.post(`/api/rooms/${unopened}/messages`, ask)).toMatchObject({
        status: 404,
        body: { reason: 'RoomNotOpen' },
      })
    }))

  test('reads messages after a sequence number, a bounded page at a time', () =>
    withApi(async ({ signIn }) => {
      const buyer = await signIn(ada)
      const bidder = await signIn(ben)
      const { room } = await negotiated(buyer, bidder)
      for (const n of [2, 3, 4, 5])
        await bidder.post(`/api/rooms/${room}/messages`, { text: `Note ${n}`, key: `n-${n}` })
      const page = (query: string) => bidder.get(`/api/rooms/${room}/messages${query}`)
      await eventually(
        () => page(''),
        (reply) => messagesOf(reply).messages.length === 5,
      )
      const first = messagesOf(await page('?limit=2'))
      expect(first.messages.map(({ seq }) => seq)).toEqual([1, 2])
      const second = messagesOf(await page(`?limit=2&after=${first.next ?? 0}`))
      expect(second.messages.map(({ seq }) => seq)).toEqual([3, 4])
      expect(messagesOf(await page(`?limit=2&after=${second.next ?? 0}`))).toEqual({
        messages: [{ seq: 5, author: bidder.account, text: 'Note 5' }],
        next: null,
      })
      expect((await page('?limit=51')).status).toBe(400)
    }))

  test('lets a member pause and resume their own agents, and no one else', () =>
    withApi(async ({ signIn }) => {
      const buyer = await signIn(ada)
      const bidder = await signIn(ben)
      const stranger = await signIn(cy)
      const { room } = await negotiated(buyer, bidder)
      expect((await bidder.post(`/api/rooms/${room}/pause`)).status).toBe(204)
      expect((await bidder.post(`/api/rooms/${room}/resume`)).status).toBe(204)
      expect(await stranger.post(`/api/rooms/${room}/pause`)).toMatchObject({
        status: 403,
        body: { reason: 'NotPermitted' },
      })
    }))
})
