import { Listing, ListingId, Message, RoomRef, roomIdOf } from '@sidequest/protocol'
import { Schema } from 'effect'
import { expect, test } from 'vitest'
import { buyerViewOf, jobViewOf, named, postJob, propose } from './Hire.ts'
import { ada, ben, bodyOf, createdId, eventually, type Person, type Reply, terms, withApi } from './HttpWorld.ts'

// The off-chain hire end to end, as two signed-in people do it over HTTP: Ben offers logos, Ada asks for one, they
// negotiate in a room until she accepts his second version, and each inbox shows each step to whom it concerns.

const rooms = (reply: Reply) => bodyOf(Schema.Struct({ rooms: Schema.Array(RoomRef) }), reply).rooms
const said = (reply: Reply) => bodyOf(Schema.Struct({ messages: Schema.Array(Message) }), reply).messages
const inboxKinds = async (person: Person, count: number) => {
  const reply = await eventually(
    () => person.get('/api/inbox'),
    (answer) => bodyOf(Schema.Struct({ items: Schema.Array(Schema.Unknown) }), answer).items.length >= count,
  )
  return bodyOf(Schema.Struct({ items: Schema.Array(Schema.Struct({ kind: Schema.String })) }), reply).items.map(
    ({ kind }) => kind,
  )
}

test('two people go from a listing to an awarded job, negotiating in a room, each told what concerns them', () =>
  withApi(async ({ signIn, anonymous }) => {
    const seller = await signIn(ben)
    const buyer = await signIn(ada)
    const listing = createdId(
      ListingId,
      await seller.post('/api/listings', { title: 'Logos', description: 'Hand-drawn logos.', tags: ['logo'] }),
    )
    await eventually(
      () => anonymous.get(`/api/listings/${listing}`),
      (reply) => Schema.is(Listing)(reply.body),
    )
    const job = await postJob(buyer)
    await propose(seller, job)
    const room = roomIdOf({ job, kind: 'negotiation', bidder: seller.account })
    await eventually(
      () => seller.get(`/api/jobs/${job}/rooms`),
      (reply) => rooms(reply).length === 1,
    )
    const say = (person: Person, text: string, key: string) => person.post(`/api/rooms/${room}/messages`, { text, key })
    await eventually(
      () => say(buyer, 'Could the logo work in one colour?', 'ada-1'),
      ({ status }) => status === 204,
    )
    const [v1] = (await buyerViewOf(buyer, job)).proposals
    if (v1 === undefined) throw new Error('No proposal arrived')
    expect((await buyer.post(`/api/jobs/${job}/change-requests`, named(v1))).status).toBe(204)
    await eventually(
      () => seller.get(`/api/jobs/${job}`),
      (reply) => {
        const shown = jobViewOf(reply)
        return shown.audience === 'bidder' && shown.view.changesRequested.includes(1)
      },
    )
    await propose(seller, job, 1, terms('300000000', ['SVG logo', 'One-colour version']))
    expect((await say(seller, 'Version 2 adds a one-colour logo.', 'ben-1')).status).toBe(204)
    const [, v2] = (await buyerViewOf(buyer, job, (view) => view.proposals.length === 2)).proposals
    if (v2 === undefined) throw new Error('Version 2 did not arrive')
    expect(await buyer.post(`/api/jobs/${job}/acceptance`, named(v1))).toMatchObject({
      status: 409,
      body: { reason: 'SupersededVersion' },
    })
    expect((await buyer.post(`/api/jobs/${job}/acceptance`, named(v2))).status).toBe(204)
    const awarded = await buyerViewOf(buyer, job, (view) => view.state === 'Awarded')
    expect(awarded.agreement).toMatchObject({ worker: seller.account, version: 2, termsDigest: v2.termsDigest })
    expect(jobViewOf(await seller.get(`/api/jobs/${job}`))).toMatchObject({
      audience: 'bidder',
      view: { outcome: 'won' },
    })
    const engagement = roomIdOf({ job, kind: 'engagement' })
    const both = await eventually(
      () => buyer.get(`/api/jobs/${job}/rooms`),
      (reply) => rooms(reply).length === 2,
    )
    expect(rooms(both).map(({ id }) => id)).toEqual([room, engagement])
    await eventually(
      () => seller.post(`/api/rooms/${engagement}/messages`, { text: 'Starting today.', key: 'ben-2' }),
      ({ status }) => status === 204,
    )
    const negotiation = await eventually(
      () => seller.get(`/api/rooms/${room}/messages`),
      (reply) => said(reply).length === 2,
    )
    expect(said(negotiation).map(({ author, text }) => [author, text])).toEqual([
      [buyer.account, 'Could the logo work in one colour?'],
      [seller.account, 'Version 2 adds a one-colour logo.'],
    ])
    // Items from the job and from the rooms reach an inbox in whichever order their projections deliver them.
    expect((await inboxKinds(buyer, 4)).toSorted()).toEqual([
      'message_posted', // Ben's note on version 2
      'message_posted', // Ben starting, in the engagement room
      'proposal_submitted',
      'proposal_submitted',
    ])
    expect((await inboxKinds(seller, 3)).toSorted()).toEqual([
      'change_requested',
      'message_posted',
      'proposal_accepted',
    ])
  }))
