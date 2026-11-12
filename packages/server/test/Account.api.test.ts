import { AccountName, Listing, ListingId, Page, PartyJob, Profile } from '@sidequest/protocol'
import { Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { buyerViewOf, named, postJob, propose } from './Hire.ts'
import { ada, ben, bodyOf, createdId, cy, eventually, type Person, type Reply, withApi } from './HttpWorld.ts'

// A person's own account over HTTP: the name others see, which they rename through the model; their own listings and
// jobs from D1, newest first, a page at a time; and anyone's lookup of the names a page shows.

const Names = Schema.Struct({ names: Schema.Array(AccountName) })
const namesOf = (reply: Reply) => bodyOf(Names, reply).names
const listingsOf = (reply: Reply) => bodyOf(Page(Listing), reply)
const jobsOf = (reply: Reply) => bodyOf(Page(PartyJob), reply)
const startingName = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`
const offer = (title: string) => ({ title, description: 'By hand.', tags: ['logo'] })
const publish = async (seller: Person, title: string) =>
  createdId(ListingId, await seller.post('/api/listings', offer(title)))

describe('the account API', () => {
  test('names every account a page shows in one lookup, and lets only the person rename their own', () =>
    withApi(async ({ signIn, anonymous }) => {
      const buyer = await signIn(ada)
      const bidder = await signIn(ben)
      const lookup = `/api/accounts/names?ids=${buyer.account},${bidder.account}`
      const both = await eventually(
        () => anonymous.get(lookup),
        (reply) => reply.status === 200 && namesOf(reply).length === 2,
      )
      expect(namesOf(both).toSorted((a, b) => a.account.localeCompare(b.account))).toEqual(
        [
          { account: buyer.account, displayName: startingName(ada.address) },
          { account: bidder.account, displayName: startingName(ben.address) },
        ].toSorted((a, b) => a.account.localeCompare(b.account)),
      )
      expect(bodyOf(Profile, await buyer.get('/api/account'))).toEqual({
        account: buyer.account,
        displayName: startingName(ada.address),
      })
      expect((await buyer.put('/api/account/name', { displayName: 'Ada Lovelace' })).status).toBe(204)
      const renamed = await eventually(
        () => anonymous.get(`/api/accounts/names?ids=${buyer.account}`),
        (reply) => namesOf(reply)[0]?.displayName === 'Ada Lovelace',
      )
      expect(namesOf(renamed)).toEqual([{ account: buyer.account, displayName: 'Ada Lovelace' }])
      expect(await anonymous.put('/api/account/name', { displayName: 'Mallory' })).toMatchObject({ status: 401 })
      expect(await anonymous.get('/api/account')).toMatchObject({ status: 401 })
      expect(await buyer.put('/api/account/name', { displayName: '  ' })).toMatchObject({ status: 400 })
      expect(await anonymous.get('/api/accounts/names?ids=nope')).toMatchObject({ status: 400 })
      const many = Array.from({ length: 101 }, () => buyer.account).join(',')
      expect(await anonymous.get(`/api/accounts/names?ids=${many}`)).toMatchObject({ status: 400 })
    }))

  test('lists a seller’s own listings, withdrawn ones too, newest first and a page at a time, to them only', () =>
    withApi(async ({ signIn }) => {
      const seller = await signIn(ada)
      const other = await signIn(ben)
      const first = await publish(seller, 'Logos')
      await publish(seller, 'Icons')
      await publish(seller, 'Posters')
      await publish(other, 'Not hers')
      expect((await seller.post(`/api/listings/${first}/withdraw`)).status).toBe(204)
      const all = await eventually(
        () => seller.get('/api/account/listings'),
        (reply) => listingsOf(reply).items.some(({ id, state }) => id === first && state === 'withdrawn'),
      )
      expect(listingsOf(all).items.map(({ title, state }) => ({ title, state }))).toEqual([
        { title: 'Posters', state: 'published' },
        { title: 'Icons', state: 'published' },
        { title: 'Logos', state: 'withdrawn' },
      ])
      const page = listingsOf(await seller.get('/api/account/listings?limit=2'))
      expect(page.items.map(({ title }) => title)).toEqual(['Posters', 'Icons'])
      const rest = listingsOf(await seller.get(`/api/account/listings?limit=2&cursor=${page.next}`))
      expect(rest).toMatchObject({ next: null })
      expect(rest.items.map(({ title }) => title)).toEqual(['Logos'])
      expect(listingsOf(await other.get('/api/account/listings')).items.map(({ title }) => title)).toEqual(['Not hers'])
    }))

  test('lists a person’s jobs as buyer, and as bidder with the one they won as worker, newest first', () =>
    withApi(async ({ signIn, anonymous }) => {
      const buyer = await signIn(ada)
      const bidder = await signIn(ben)
      const stranger = await signIn(cy)
      const won = await postJob(buyer, 'The one Ben wins')
      const lost = await postJob(buyer, 'The one Cy wins')
      const untouched = await postJob(buyer, 'No bids')
      await propose(bidder, won)
      await propose(bidder, lost)
      await propose(stranger, lost)
      const [bid] = (await buyerViewOf(buyer, won, (view) => view.proposals.length === 1)).proposals
      if (bid === undefined) throw new Error('No proposal arrived')
      expect((await buyer.post(`/api/jobs/${won}/acceptance`, named(bid))).status).toBe(204)
      const bids = await eventually(
        () => bidder.get('/api/account/jobs?as=bidder'),
        (reply) => jobsOf(reply).items.some(({ role }) => role === 'worker'),
      )
      expect(jobsOf(bids).items.map(({ id, state, role }) => ({ id, state, role }))).toEqual([
        { id: lost, state: 'Open', role: 'bidder' },
        { id: won, state: 'Awarded', role: 'worker' },
      ])
      const posted = jobsOf(await buyer.get('/api/account/jobs?as=buyer&limit=2'))
      expect(posted.items.map(({ id, role }) => ({ id, role }))).toEqual([
        { id: untouched, role: 'buyer' },
        { id: lost, role: 'buyer' },
      ])
      const older = jobsOf(await buyer.get(`/api/account/jobs?as=buyer&limit=2&cursor=${posted.next}`))
      expect(older).toMatchObject({ next: null, items: [{ id: won, state: 'Awarded', title: 'The one Ben wins' }] })
      expect(jobsOf(await buyer.get('/api/account/jobs?as=bidder')).items).toEqual([])
      expect(jobsOf(await bidder.get('/api/account/jobs?as=buyer')).items).toEqual([])
      expect(await anonymous.get('/api/account/jobs?as=buyer')).toMatchObject({ status: 401 })
      expect(await buyer.get('/api/account/jobs?as=worker')).toMatchObject({ status: 400 })
      expect(await buyer.get('/api/account/jobs?as=buyer&cursor=bm9wZQ')).toMatchObject({
        status: 400,
        body: { _tag: 'BadCursor' },
      })
    }))
})
