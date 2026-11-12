import { Listing, ListingId, Page, UsdcOnArcTestnet } from '@sidequest/protocol'
import { describe, expect, test } from 'vitest'
import { ada, ben, bodyOf, type Client, createdId, eventually, type Person, type Reply, withApi } from './HttpWorld.ts'

// Listings over HTTP: their owners publish, update and withdraw them through the model; anyone reads one, or searches
// the published ones, from the `listings` projection.

const offer = {
  title: 'Hand-drawn logos',
  description: 'A logo in a week, drawn by hand, delivered as SVG.',
  tags: ['logo', 'illustration'],
  priceHint: { amount: '250000000', asset: UsdcOnArcTestnet.id },
}
const publish = async (seller: Person, details = offer) =>
  createdId(ListingId, await seller.post('/api/listings', details))
const search = (client: Client, query: string) => client.get(`/api/listings?${query}`)
const found = (reply: Reply) => bodyOf(Page(Listing), reply)
const titles = (reply: Reply) => found(reply).items.map(({ title }) => title)

describe('the listings API', () => {
  test('publishes a listing anyone can read whole, updates it, and withdraws it from search', () =>
    withApi(async ({ signIn, anonymous }) => {
      const seller = await signIn(ada)
      const id = await publish(seller)
      const read = await eventually(
        () => anonymous.get(`/api/listings/${id}`),
        ({ status }) => status === 200,
      )
      expect(bodyOf(Listing, read)).toEqual({ id, owner: seller.account, ...offer, state: 'published' })
      const revised = { ...offer, title: 'Hand-drawn logos and icons', tags: ['logo', 'icons'] }
      const { priceHint, ...withoutPrice } = revised
      expect((await seller.put(`/api/listings/${id}`, withoutPrice)).status).toBe(204)
      const updated = await eventually(
        () => anonymous.get(`/api/listings/${id}`),
        (reply) => bodyOf(Listing, reply).title === revised.title,
      )
      expect(bodyOf(Listing, updated)).toEqual({ id, owner: seller.account, ...withoutPrice, state: 'published' })
      expect((await seller.post(`/api/listings/${id}/withdraw`)).status).toBe(204)
      await eventually(
        () => anonymous.get(`/api/listings/${id}`),
        (reply) => bodyOf(Listing, reply).state === 'withdrawn',
      )
      expect(found(await search(anonymous, 'q=logo')).items).toEqual([])
    }))

  test('finds published listings by title or tag, letter case aside, newest first, a page at a time', () =>
    withApi(async ({ signIn, anonymous }) => {
      const seller = await signIn(ada)
      await publish(seller, { ...offer, title: 'Logo sketches', tags: ['draft'] })
      await publish(seller, { ...offer, title: 'Brand sheets', tags: ['LOGO', 'print'] })
      await publish(seller, { ...offer, title: 'Wedding cards', tags: ['print'] })
      await publish(seller, { ...offer, title: '100% vector art', tags: ['svg'] })
      await eventually(
        () => search(anonymous, ''),
        (reply) => found(reply).items.length === 4,
      )
      expect(titles(await search(anonymous, 'q=logo'))).toEqual(['Brand sheets', 'Logo sketches'])
      expect(titles(await search(anonymous, 'q=PRINT'))).toEqual(['Wedding cards', 'Brand sheets'])
      // `%` and `_` are text to search for, not wildcards.
      expect(titles(await search(anonymous, 'q=%25'))).toEqual(['100% vector art'])
      expect(titles(await search(anonymous, 'q=_'))).toEqual([])
      const first = found(await search(anonymous, 'limit=3'))
      const rest = found(await search(anonymous, `limit=3&cursor=${first.next ?? ''}`))
      expect([...first.items, ...rest.items].map(({ title }) => title)).toEqual([
        '100% vector art',
        'Wedding cards',
        'Brand sheets',
        'Logo sketches',
      ])
      expect(rest.next).toBeNull()
      expect(await search(anonymous, 'cursor=e30')).toMatchObject({ status: 400, body: { _tag: 'BadCursor' } })
    }))

  test('lets only the owner change a listing, and answers what was never published with 404', () =>
    withApi(async ({ signIn, anonymous }) => {
      const seller = await signIn(ada)
      const stranger = await signIn(ben)
      const id = await publish(seller)
      expect(await stranger.post(`/api/listings/${id}/withdraw`)).toMatchObject({
        status: 403,
        body: { reason: 'NotPermitted', evidence: { account: stranger.account, required: 'owner' } },
      })
      const unknown = 'listing_01JCXZ4Q6N8M2V7T3R5W9Y0B1Z'
      expect(await seller.put(`/api/listings/${unknown}`, offer)).toMatchObject({
        status: 404,
        body: { reason: 'ListingNotPublished', evidence: { state: 'Unpublished' } },
      })
      expect(await anonymous.get(`/api/listings/${unknown}`)).toMatchObject({
        status: 404,
        body: { _tag: 'NotFound', reason: 'UnknownListing' },
      })
      await seller.post(`/api/listings/${id}/withdraw`)
      expect(await seller.put(`/api/listings/${id}`, offer)).toMatchObject({
        status: 409,
        body: { _tag: 'Conflict', reason: 'ListingNotPublished', evidence: { state: 'Withdrawn' } },
      })
      expect((await anonymous.post('/api/listings', offer)).status).toBe(401)
    }))
})
