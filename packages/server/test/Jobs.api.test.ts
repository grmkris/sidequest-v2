import { OpenRequest, Page } from '@sidequest/protocol'
import { arcTestnet } from '@sidequest/settlement/SettlementChain'
import { Option, Redacted } from 'effect'
import { describe, expect, test } from 'vitest'
import {
  artifactHash,
  buyerViewOf,
  jobViewOf,
  named,
  postJob,
  propose,
  recordDelivery,
  recordFunding,
  recordRejection,
  recordSettlement,
} from './Hire.ts'
import { ada, ben, bodyOf, cy, eventually, inSeconds, type Reply, request, terms, withApi } from './HttpWorld.ts'
import { fakeArc, signInWorld } from './World.ts'

// The hire over HTTP up to the chain: requests, proposals, the award and what follows it, each refused where the
// model refuses, with the chain's reports sent to the model directly.

const openPage = (reply: Reply) => bodyOf(Page(OpenRequest), reply)

/** A world whose escrow is configured with a 2.5 % fee; nothing here reaches its chain. */
const feeWorld = signInWorld(fakeArc().client, {
  escrow: Option.some({
    chain: arcTestnet({
      operator: '0x1000000000000000000000000000000000000001',
      feeReceiver: '0x1000000000000000000000000000000000000002',
      arbitrator: '0x1000000000000000000000000000000000000003',
      feeBps: 250,
    }),
    relayerKey: Redacted.make(`0x${'42'.repeat(32)}` as const),
    arbitratorKey: Option.none(),
    arbitrationOperator: Option.none(),
  }),
}).layer
const delivery = { artifactHash, url: 'https://files.example/logo.zip' }
/** A wallet signature's shape; these tests never reach a chain that would check it. */
const signature = `0x${'11'.repeat(65)}`

describe('the jobs API', () => {
  test('lists an open request to anyone, and shows a job to its buyer, a bidder and anyone else as theirs', () =>
    withApi(async ({ signIn, anonymous }) => {
      const buyer = await signIn(ada)
      const bidder = await signIn(ben)
      const stranger = await signIn(cy)
      const job = await postJob(buyer)
      const open = await eventually(
        () => anonymous.get('/api/jobs'),
        (reply) => openPage(reply).items.length === 1,
      )
      expect(openPage(open).items.map(({ id, buyer: by, title }) => ({ id, by, title }))).toEqual([
        { id: job, by: buyer.account, title: request().title },
      ])
      expect(jobViewOf(await anonymous.get(`/api/jobs/${job}`))).toMatchObject({
        audience: 'public',
        view: { state: 'Open' },
      })
      expect((await buyerViewOf(buyer, job)).request?.buyer).toBe(buyer.account)
      await propose(bidder, job)
      const asBidder = await eventually(
        () => bidder.get(`/api/jobs/${job}`),
        (reply) => jobViewOf(reply).audience === 'bidder',
      )
      expect(jobViewOf(asBidder)).toMatchObject({
        audience: 'bidder',
        view: {
          request: { id: job, buyer: buyer.account, title: request().title },
          state: 'Open',
          bidder: bidder.account,
          outcome: 'pending',
          reviews: [],
          fee: null,
        },
      })
      expect(jobViewOf(await stranger.get(`/api/jobs/${job}`)).audience).toBe('public')
      expect(await anonymous.get('/api/jobs/job_01JCXZ4Q6N8M2V7T3R5W9Y0B1Z')).toMatchObject({
        status: 404,
        body: { _tag: 'NotFound', reason: 'UnknownJob' },
      })
    }))

  test('refuses a past expiry, a bid on your own request, a stale head, and a change only the buyer may ask', () =>
    withApi(async ({ signIn }) => {
      const buyer = await signIn(ada)
      const bidder = await signIn(ben)
      const stranger = await signIn(cy)
      expect(await buyer.post('/api/jobs', { ...request(), expiresAt: inSeconds(-1) })).toMatchObject({
        status: 422,
        body: { reason: 'ExpiryNotInFuture' },
      })
      const job = await postJob(buyer)
      expect(await buyer.post(`/api/jobs/${job}/proposals`, { terms: terms() })).toMatchObject({
        status: 403,
        body: { reason: 'SelfBid', evidence: { bidder: buyer.account } },
      })
      expect(await bidder.post(`/api/jobs/${job}/proposals`, { previous: 1, terms: terms() })).toMatchObject({
        status: 409,
        body: { reason: 'StaleHead', evidence: { head: null, previous: 1 } },
      })
      await propose(bidder, job)
      const [first] = (await buyerViewOf(buyer, job, (view) => view.proposals.length === 1)).proposals
      if (first === undefined) throw new Error('No proposal arrived')
      expect(await stranger.post(`/api/jobs/${job}/change-requests`, named(first))).toMatchObject({
        status: 403,
        body: { reason: 'NotPermitted', evidence: { required: 'buyer' } },
      })
      expect(
        await buyer.post(`/api/jobs/${job}/change-requests`, { ...named(first), bidder: stranger.account }),
      ).toMatchObject({
        status: 404,
        body: { reason: 'NoProposal' },
      })
      expect((await buyer.post(`/api/jobs/${job}/change-requests`, named(first))).status).toBe(204)
    }))

  test('accepts only the bidder’s head version with its exact digest, once', () =>
    withApi(async ({ signIn }) => {
      const buyer = await signIn(ada)
      const bidder = await signIn(ben)
      const job = await postJob(buyer)
      await propose(bidder, job)
      await propose(bidder, job, 1, terms('300000000'))
      const [v1, v2] = (await buyerViewOf(buyer, job, (view) => view.proposals.length === 2)).proposals
      if (v1 === undefined || v2 === undefined) throw new Error('The proposals did not arrive')
      expect(await buyer.post(`/api/jobs/${job}/acceptance`, named(v1))).toMatchObject({
        status: 409,
        body: { reason: 'SupersededVersion', evidence: { head: 2, named: 1 } },
      })
      expect(
        await buyer.post(`/api/jobs/${job}/acceptance`, { ...named(v2), termsDigest: v1.termsDigest }),
      ).toMatchObject({
        status: 409,
        body: { reason: 'DigestMismatch' },
      })
      expect((await buyer.post(`/api/jobs/${job}/acceptance`, named(v2))).status).toBe(204)
      expect((await buyerViewOf(buyer, job, (view) => view.state === 'Awarded')).agreement?.version).toBe(2)
      expect(await buyer.post(`/api/jobs/${job}/acceptance`, named(v2))).toMatchObject({
        status: 409,
        body: { reason: 'WrongState', evidence: { state: 'Awarded', expected: ['Open'] } },
      })
      expect(await buyer.post(`/api/jobs/${job}/cancellation`)).toMatchObject({
        status: 409,
        body: { reason: 'WrongState' },
      })
    }))

  test('cancels an open request for its buyer alone, and drops it from the open requests', () =>
    withApi(async ({ signIn, anonymous }) => {
      const buyer = await signIn(ada)
      const bidder = await signIn(ben)
      const job = await postJob(buyer)
      await eventually(
        () => anonymous.get('/api/jobs'),
        (reply) => openPage(reply).items.length === 1,
      )
      expect(await bidder.post(`/api/jobs/${job}/cancellation`)).toMatchObject({
        status: 403,
        body: { reason: 'NotPermitted' },
      })
      expect((await buyer.post(`/api/jobs/${job}/cancellation`)).status).toBe(204)
      const closed = await eventually(
        () => anonymous.get('/api/jobs'),
        (reply) => openPage(reply).items.length === 0,
      )
      expect(openPage(closed)).toEqual({ items: [], next: null })
    }))

  test('pages the open requests soonest to expire first, with an opaque cursor', () =>
    withApi(async ({ signIn, anonymous }) => {
      const buyer = await signIn(ada)
      for (const [title, days] of [
        ['Later', 9],
        ['Soon', 2],
        ['Middle', 5],
      ] as const)
        await buyer.post('/api/jobs', { ...request(title), expiresAt: inSeconds(days * 86_400) })
      await eventually(
        () => anonymous.get('/api/jobs'),
        (reply) => openPage(reply).items.length === 3,
      )
      const first = openPage(await anonymous.get('/api/jobs?limit=2'))
      const rest = openPage(await anonymous.get(`/api/jobs?limit=2&cursor=${first.next ?? ''}`))
      expect([...first.items, ...rest.items].map(({ title }) => title)).toEqual(['Soon', 'Middle', 'Later'])
      expect(rest.next).toBeNull()
    }))

  test('lets the worker deliver once the chain reports funding, the buyer approve on chain, and both review after', () =>
    withApi(async (api) => {
      const buyer = await api.signIn(ada)
      const worker = await api.signIn(ben)
      const stranger = await api.signIn(cy)
      const job = await postJob(buyer)
      await propose(worker, job)
      const [offer] = (await buyerViewOf(buyer, job, (view) => view.proposals.length === 1)).proposals
      if (offer === undefined) throw new Error('No proposal arrived')
      expect(await worker.post(`/api/jobs/${job}/delivery`, delivery)).toMatchObject({
        status: 409,
        body: { reason: 'WrongState' },
      })
      await buyer.post(`/api/jobs/${job}/acceptance`, named(offer))
      const { agreement } = await buyerViewOf(buyer, job, (view) => view.agreement !== null)
      if (agreement === null) throw new Error('No agreement')
      await recordFunding(api, agreement)
      expect(await stranger.post(`/api/jobs/${job}/delivery`, delivery)).toMatchObject({
        status: 403,
        body: { reason: 'NotPermitted' },
      })
      expect((await worker.post(`/api/jobs/${job}/delivery`, delivery)).status).toBe(204)
      await recordDelivery(api, job)
      // An approval is the buyer's signature for the chain. Only the buyer may post one, and with no escrow
      // configured there is no chain to relay it to.
      expect(await worker.post(`/api/jobs/${job}/approval`, { signature })).toMatchObject({
        status: 403,
        body: { reason: 'NotPermitted' },
      })
      expect((await buyer.post(`/api/jobs/${job}/approval`, { signature })).status).toBe(503)
      expect(await buyer.post(`/api/jobs/${job}/reviews`, { rating: 5 })).toMatchObject({
        status: 409,
        body: { reason: 'WrongState' },
      })
      await recordSettlement(api, agreement)
      expect((await buyer.post(`/api/jobs/${job}/reviews`, { rating: 5, comment: 'Lovely work.' })).status).toBe(204)
      expect((await worker.post(`/api/jobs/${job}/reviews`, { rating: 4 })).status).toBe(204)
      expect(await buyer.post(`/api/jobs/${job}/reviews`, { rating: 1 })).toMatchObject({
        status: 409,
        body: { reason: 'AlreadyReviewed' },
      })
      expect(await stranger.post(`/api/jobs/${job}/reviews`, { rating: 1 })).toMatchObject({
        status: 403,
        body: { reason: 'NotPermitted', evidence: { required: 'party' } },
      })
      const settled = await buyerViewOf(buyer, job, (view) => view.reviews.length === 2)
      expect(settled).toMatchObject({ state: 'Settled', outcome: 'paid', delivery: { ...delivery, job } })
      // The worker sees the job settled and who reviewed it; with no escrow configured, no fee to show.
      const asWorker = await eventually(
        () => worker.get(`/api/jobs/${job}`),
        (reply) => {
          const shown = jobViewOf(reply)
          return shown.audience === 'bidder' && shown.view.state === 'Settled' && shown.view.reviews.length === 2
        },
      )
      expect(jobViewOf(asWorker)).toMatchObject({ audience: 'bidder', view: { outcome: 'won', fee: null } })
      const shownToWorker = jobViewOf(asWorker)
      const reviewers =
        shownToWorker.audience === 'bidder' ? shownToWorker.view.reviews.map(({ author }) => author) : []
      expect(reviewers.toSorted()).toEqual([buyer.account, worker.account].toSorted())
    }))

  test('shows the worker the escrow’s fee on what they won, and no fee to a bidder who lost', () =>
    withApi(async ({ signIn }) => {
      const buyer = await signIn(ada)
      const worker = await signIn(ben)
      const loser = await signIn(cy)
      const job = await postJob(buyer)
      await propose(worker, job, undefined, terms('300000001'))
      await propose(loser, job)
      const [offer] = (await buyerViewOf(buyer, job, (view) => view.proposals.length === 2)).proposals.filter(
        ({ bidder }) => bidder === worker.account,
      )
      if (offer === undefined) throw new Error('No proposal arrived')
      expect((await buyer.post(`/api/jobs/${job}/acceptance`, named(offer))).status).toBe(204)
      const won = await eventually(
        () => worker.get(`/api/jobs/${job}`),
        (reply) => {
          const shown = jobViewOf(reply)
          return shown.audience === 'bidder' && shown.view.outcome === 'won'
        },
      )
      // 2.5 % of 300.000001 USDC, rounded down as the escrow rounds.
      expect(jobViewOf(won)).toMatchObject({ view: { state: 'Awarded', fee: { bps: 250, amount: '7500000' } } })
      const lost = await eventually(
        () => loser.get(`/api/jobs/${job}`),
        (reply) => {
          const shown = jobViewOf(reply)
          return shown.audience === 'bidder' && shown.view.outcome === 'lost'
        },
      )
      expect(jobViewOf(lost)).toMatchObject({ view: { fee: null } })
    }, feeWorld))

  test('opens a dispute only when the chain reports the rejection, whatever a client posts', () =>
    withApi(async (api) => {
      const buyer = await api.signIn(ada)
      const worker = await api.signIn(ben)
      const job = await postJob(buyer)
      await propose(worker, job)
      const [offer] = (await buyerViewOf(buyer, job, (view) => view.proposals.length === 1)).proposals
      if (offer === undefined) throw new Error('No proposal arrived')
      await buyer.post(`/api/jobs/${job}/acceptance`, named(offer))
      const { agreement } = await buyerViewOf(buyer, job, (view) => view.agreement !== null)
      if (agreement === null) throw new Error('No agreement')
      await recordFunding(api, agreement)
      await recordDelivery(api, job)
      const reason = 'The favicon set is missing.'
      expect((await buyer.post(`/api/jobs/${job}/rejection`, { signature, reason })).status).toBe(503)
      expect((await buyerViewOf(buyer, job)).state).toBe('Delivered')
      await recordRejection(api, job)
      const disputed = await buyerViewOf(buyer, job, (view) => view.state === 'Disputed')
      expect(disputed.dispute).toMatchObject({ reason: null, workerShareBps: null, ruling: null })
    }))
})
