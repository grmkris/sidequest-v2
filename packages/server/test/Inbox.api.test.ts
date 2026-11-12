import { Cursor, InboxEntry } from '@sidequest/protocol'
import { Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { buyerViewOf, named, postJob, propose } from './Hire.ts'
import { ada, ben, bodyOf, eventually, type Person, type Reply, withApi } from './HttpWorld.ts'

// A person's inbox over HTTP, from the `inbox_items` projection: what concerns them, in the order it reached them,
// a page at a time, with a cursor to poll with.

const Inbox = Schema.Struct({ items: Schema.Array(InboxEntry), next: Cursor, more: Schema.Boolean })
const Recent = Schema.Struct({ items: Schema.Array(InboxEntry), next: Schema.NullOr(Cursor), latest: Cursor })
const recentOf = (reply: Reply) => bodyOf(Recent, reply)
const inboxOf = (reply: Reply) => bodyOf(Inbox, reply)
const kinds = (reply: Reply) => inboxOf(reply).items.map(({ kind }) => kind)
const read = (person: Person, query = '') => person.get(`/api/inbox${query}`)

describe('the inbox API', () => {
  test('shows each person what concerns them: the buyer proposals, the bidder change requests and the award', () =>
    withApi(async ({ signIn }) => {
      const buyer = await signIn(ada)
      const bidder = await signIn(ben)
      const job = await postJob(buyer)
      await propose(bidder, job)
      const [v1] = (await buyerViewOf(buyer, job)).proposals
      if (v1 === undefined) throw new Error('No proposal arrived')
      await buyer.post(`/api/jobs/${job}/change-requests`, named(v1))
      await propose(bidder, job, 1)
      const [, v2] = (await buyerViewOf(buyer, job, (view) => view.proposals.length === 2)).proposals
      if (v2 === undefined) throw new Error('No second version arrived')
      await buyer.post(`/api/jobs/${job}/acceptance`, named(v2))
      const buyers = await eventually(
        () => read(buyer),
        (reply) => kinds(reply).length === 2,
      )
      const items = inboxOf(buyers).items
      expect(items.map(({ kind, job: about, room }) => ({ kind, about, room }))).toEqual([
        { kind: 'proposal_submitted', about: job, room: null },
        { kind: 'proposal_submitted', about: job, room: null },
      ])
      expect(new Set(items.map(({ id }) => id)).size).toBe(2)
      const bidders = await eventually(
        () => read(bidder),
        (reply) => kinds(reply).length === 2,
      )
      expect(kinds(bidders)).toEqual(['change_requested', 'proposal_accepted'])
    }))

  test('reads a bounded page after a cursor, and answers the cursor to poll with when nothing is new', () =>
    withApi(async ({ signIn }) => {
      const buyer = await signIn(ada)
      const bidder = await signIn(ben)
      for (const title of ['One', 'Two', 'Three']) await propose(bidder, await postJob(buyer, title))
      await eventually(
        () => read(buyer),
        (reply) => kinds(reply).length === 3,
      )
      const first = inboxOf(await read(buyer, '?limit=2'))
      expect(first).toMatchObject({ more: true })
      expect(first.items).toHaveLength(2)
      const rest = inboxOf(await read(buyer, `?limit=2&cursor=${first.next}`))
      expect(rest).toMatchObject({ more: false })
      expect(rest.items).toHaveLength(1)
      const polled = inboxOf(await read(buyer, `?cursor=${rest.next}`))
      expect(polled).toEqual({ items: [], next: rest.next, more: false })
      expect(inboxOf(await read(bidder)).items).toEqual([])
      expect(await read(buyer, '?cursor=bm9wZQ')).toMatchObject({ status: 400, body: { _tag: 'BadCursor' } })
    }))

  test('reads newest first a page at a time back to the oldest, and answers the cursor to poll for what comes next', () =>
    withApi(async ({ signIn, anonymous }) => {
      const buyer = await signIn(ada)
      const bidder = await signIn(ben)
      for (const title of ['One', 'Two', 'Three']) await propose(bidder, await postJob(buyer, title))
      const oldestFirst = await eventually(
        () => read(buyer),
        (reply) => kinds(reply).length === 3,
      )
      const ids = inboxOf(oldestFirst).items.map(({ id }) => id)
      const newest = recentOf(await buyer.get('/api/inbox/recent?limit=2'))
      expect(newest.items.map(({ id }) => id)).toEqual([ids[2], ids[1]])
      const oldest = recentOf(await buyer.get(`/api/inbox/recent?limit=2&cursor=${newest.next}`))
      expect(oldest).toMatchObject({ next: null })
      expect(oldest.items.map(({ id }) => id)).toEqual([ids[0]])
      expect(inboxOf(await read(buyer, `?cursor=${newest.latest}`))).toMatchObject({ items: [], more: false })
      const job = await postJob(buyer, 'Four')
      await propose(bidder, job)
      const polled = await eventually(
        () => read(buyer, `?cursor=${newest.latest}`),
        (reply) => kinds(reply).length === 1,
      )
      expect(inboxOf(polled).items.map(({ job: about }) => about)).toEqual([job])
      expect(recentOf(await bidder.get('/api/inbox/recent'))).toMatchObject({ items: [], next: null })
      // A cursor that polls forwards does not page backwards.
      expect(await buyer.get(`/api/inbox/recent?cursor=${newest.latest}`)).toMatchObject({
        status: 400,
        body: { _tag: 'BadCursor' },
      })
      expect(await anonymous.get('/api/inbox/recent')).toMatchObject({ status: 401 })
    }))
})
