import { PeopleApi } from '@sidequest/domain/People.api'
import { describe, expect, test } from 'vitest'
import { JobId } from '@sidequest/protocol'
import { buyerViewOf, postJob, propose } from './Hire.ts'
import { ada, ben, createdId, cy, origin, request, terms, withApi } from './HttpWorld.ts'

// What no HTTP request can reach: the system's commands, and anyone's account but the session's own.

/** The commands only the system sends: the chain's reports, the request's expiry, rooms opening, sign-in's claims. */
const systemCommands = [
  'RecordFunding',
  'RecordDelivery',
  'RecordRejection',
  'RecordRuling',
  'RecordSettlement',
  'ExpireRequest',
  'OpenRoom',
  'ReserveWallet',
  'ClaimWallet',
]

describe('what the HTTP API cannot reach', () => {
  test('the system’s commands: the Api the handlers call holds none, and no route sends one', () =>
    withApi(async ({ signIn }) => {
      const reachable = PeopleApi.entries.flatMap((entry) => (entry.kind === 'Command' ? [entry.tag] : []))
      expect(reachable.filter((tag) => systemCommands.includes(tag))).toEqual([])
      expect(reachable).toContain('AcceptProposal')
      const buyer = await signIn(ada)
      const job = await postJob(buyer)
      for (const path of ['funded', 'delivery-recorded', 'rejected', 'settlement', 'expiry'])
        expect((await buyer.post(`/api/jobs/${job}/${path}`, {})).status).toBe(404)
      // What a person may post is a signature for the chain, and only in the stage it belongs to; a ruling only from
      // the configured arbitration operator.
      const signature = `0x${'11'.repeat(65)}`
      expect(await buyer.post(`/api/jobs/${job}/funding`, { signature })).toMatchObject({
        status: 409,
        body: { reason: 'WrongState' },
      })
      expect(await buyer.post(`/api/jobs/${job}/ruling`, { workerShareBps: 10_000 })).toMatchObject({
        status: 403,
        body: { reason: 'NotPermitted' },
      })
      expect((await buyer.post('/rpc', { _tag: 'Request', tag: 'RecordFunding' })).status).toBe(404)
    }))

  test('another account: identity comes from the session cookie only, never from the request', () =>
    withApi(async ({ signIn, fetch }) => {
      const buyer = await signIn(ada)
      const other = await signIn(cy)
      const job = createdId(JobId, await buyer.post('/api/jobs', { ...request(), buyer: other.account }))
      const bidder = await signIn(ben)
      await propose(bidder, job)
      await bidder.post(`/api/jobs/${job}/proposals`, { previous: 1, terms: terms(), bidder: other.account })
      const view = await buyerViewOf(buyer, job, (shown) => shown.proposals.length === 2)
      expect(view.request?.buyer).toBe(buyer.account)
      expect(view.proposals.map(({ bidder: who }) => who)).toEqual([bidder.account, bidder.account])
      const forged = await fetch(`/api/jobs/${job}/cancellation`, {
        method: 'POST',
        headers: { origin, cookie: '__Host-sidequest-session=' + 'f'.repeat(64), 'x-sidequest-account': buyer.account },
      })
      expect(forged.status).toBe(401)
      expect(await other.post(`/api/jobs/${job}/cancellation`)).toMatchObject({
        status: 403,
        body: { reason: 'NotPermitted' },
      })
    }))
})
