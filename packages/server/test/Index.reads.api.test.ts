import { JobView } from '@sidequest/fold'
import { publicKeyOf } from '@sidequest/nostr'
import { IndexListing, IndexListingDetail, Page } from '@sidequest/protocol'
import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import { ChainFacts, type ChainLog } from '../src/Index/ChainFacts.ts'
import { OpenJob } from '../src/Index/Jobs.ts'
import { type Api, bodyOf, withApi } from './HttpWorld.ts'
import { accountOf, alice, bob, carol, linked, profile, walletOne, walletTwo } from './IndexWorld.ts'
import {
  acceptBy,
  deliveredFact,
  fundedFact,
  listingBy,
  noteBy,
  onArc,
  proposalBy,
  releasedFact,
  requestBy,
  statementBy,
  termsFrom,
  walletOfKey,
} from './JobWorld.ts'

// The index's listing and job reads over HTTP, as any client reads them: no session, no cookie, no origin.

const now = () => Math.floor(Date.now() / 1000)

const publish = async (fetch: Api['fetch'], event: unknown) => {
  const response = await fetch('/api/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.7' },
    body: JSON.stringify(event),
  })
  expect(response.status).toBe(200)
}

const read = async (fetch: Api['fetch'], path: string) => {
  const response = await fetch(path)
  const text = await response.text()
  const body: unknown = text === '' ? null : JSON.parse(text)
  return { status: response.status, body, cache: response.headers.get('cache-control') }
}

const record = (run: Api['run'], logs: ReadonlyArray<ChainLog>) =>
  run(Effect.flatMap(ChainFacts, (facts) => facts.record(logs)))

describe('reading listings from the index', () => {
  test('searches newest first with a cursor, and answers one listing by its seller and slug', () =>
    withApi(async ({ fetch }) => {
      const at = now()
      for (const event of [
        profile(bob, at, { name: 'Bob' }),
        await linked(bob, walletOne, at),
        listingBy(bob, 'guides', at - 10, { title: 'Guides old' }),
        listingBy(bob, 'guides', at, { title: 'Guides' }),
        listingBy(carol, 'logos', at - 5, { title: 'Logos', topics: ['design'] }),
      ])
        await publish(fetch, event)
      const first = await read(fetch, '/api/index/listings?limit=1')
      expect(first.cache).toBe('public, max-age=30')
      const page = bodyOf(Page(IndexListing), first)
      expect(page.items.map(({ title, author }) => [title, author])).toEqual([
        ['Guides', { name: 'Bob', walletVerified: true }],
      ])
      const second = bodyOf(Page(IndexListing), await read(fetch, `/api/index/listings?limit=1&cursor=${page.next}`))
      expect(second.items.map(({ title }) => title)).toEqual(['Logos'])
      expect(second.next).toBeNull()
      const tagged = bodyOf(Page(IndexListing), await read(fetch, '/api/index/listings?tag=design&q=logo'))
      expect(tagged.items.map(({ slug }) => slug)).toEqual(['logos'])
      const one = await read(fetch, `/api/index/listings/${publicKeyOf(bob)}/guides`)
      expect(bodyOf(IndexListingDetail, one)).toMatchObject({ title: 'Guides', description: 'I translate guides.' })
      expect(await read(fetch, `/api/index/listings/${publicKeyOf(bob)}/nothing`)).toMatchObject({
        status: 404,
        body: { _tag: 'NotIndexed' },
      })
      expect(await read(fetch, '/api/index/listings?cursor=bogus')).toMatchObject({
        status: 400,
        body: { _tag: 'BadCursor' },
      })
    }))
})

describe('reading a job from the index', () => {
  test('follows a hire from signed events and chain facts: proposed, accepted, funded with known terms, released', () =>
    withApi(async ({ fetch, run }) => {
      const at = now()
      const job = await requestBy(alice, at)
      // Both parties' wallets are linked to their keys, so the funding's payer and receiver are known people.
      for (const link of [await linked(alice, walletOne, at), await linked(bob, walletTwo, at)])
        await publish(fetch, link)
      const stageOf = async () => bodyOf(JobView, await read(fetch, `/api/index/jobs/${job.id}`))
      expect(await read(fetch, `/api/index/jobs/${job.id}`)).toMatchObject({
        status: 404,
        body: { _tag: 'NotIndexed' },
      })
      await publish(fetch, job)
      expect((await stageOf()).stage).toBe('open')
      const offered = termsFrom(at)
      const proposal = await proposalBy(bob, job, at + 1, offered, accountOf(walletTwo))
      await publish(fetch, proposal)
      expect((await stageOf()).stage).toBe('proposed')
      await publish(fetch, await acceptBy(alice, proposal, at + 2))
      const accepted = await read(fetch, `/api/index/jobs/${job.id}`)
      expect(accepted.cache).toBe('public, max-age=10')
      expect(bodyOf(JobView, accepted)).toMatchObject({ stage: 'accepted', buyer: job.pubkey, worker: null })
      await record(run, [onArc(fundedFact(proposal, accountOf(walletOne), 100, offered), '01')])
      expect(await stageOf()).toMatchObject({
        stage: 'funded',
        worker: proposal.pubkey,
        funding: {
          proposal: proposal.id,
          terms: 'known',
          termsMatchChain: true,
          payerLinked: true,
          receiverLinked: true,
        },
      })
      const hash = `0x${'de'.repeat(32)}`
      await publish(fetch, await noteBy(bob, job, at + 3, hash))
      await record(run, [onArc(deliveredFact(110, at + 3, hash), '02')])
      expect(await stageOf()).toMatchObject({
        stage: 'delivered',
        deliveryNotes: [{ fromWorker: true, matchesChain: true }],
      })
      await record(run, [onArc(releasedFact(120, at + 4), '03')])
      expect((await stageOf()).stage).toBe('released')
    }))

  test('lists the open requests as the fold sees them, newest first, with their proposals counted', () =>
    withApi(async ({ fetch, run }) => {
      const at = now()
      const open = await requestBy(alice, at - 3, undefined, 'Open')
      const closed = await requestBy(alice, at - 2, undefined, 'Closed')
      const funded = await requestBy(carol, at - 1, undefined, 'Funded')
      const offered = termsFrom(at)
      const bid = await proposalBy(bob, open, at, offered)
      const fundedBid = await proposalBy(bob, funded, at, offered)
      for (const event of [
        open,
        closed,
        funded,
        bid,
        fundedBid,
        await statementBy(alice, closed.id, 'withdraw_request', at),
      ])
        await publish(fetch, event)
      await record(run, [onArc(fundedFact(fundedBid, walletOfKey(carol), 100, offered), '01')])
      const listed = await read(fetch, '/api/index/jobs?stage=open')
      expect(listed.cache).toBe('public, max-age=10')
      const page = bodyOf(Page(OpenJob), listed)
      expect(page.items.map(({ job, proposals }) => [job, proposals])).toEqual([[open.id, 1]])
      for (const request of [open, closed, funded]) {
        const stage = bodyOf(JobView, await read(fetch, `/api/index/jobs/${request.id}`)).stage
        expect(['open', 'proposed', 'accepted'].includes(stage)).toBe(request === open)
      }
      expect((await read(fetch, '/api/index/jobs?stage=closed')).status).toBe(400)
      const unexpired = bodyOf(Page(OpenJob), await read(fetch, '/api/index/jobs?stage=open&expired=exclude'))
      expect(unexpired.items.map(({ job }) => job)).toEqual([open.id])
    }))
})
