import { Cursor, InboxEntry } from '@sidequest/protocol'
import { Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { buyerViewOf, named, postJob, propose } from './Hire.ts'
import { ada, ben, bodyOf, eventually, type Person, type Reply, withApi } from './HttpWorld.ts'

// A person's inbox over HTTP, from the `inbox_items` projection: what concerns them, in the order it reached them,
// a page at a time, with a cursor to poll with.

const Inbox = Schema.Struct({ items: Schema.Array(InboxEntry), next: Cursor, more: Schema.Boolean })
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
})
