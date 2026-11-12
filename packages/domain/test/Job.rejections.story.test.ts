import { Story } from '@alchemy.run/domain/Story'
import { describe, it } from '@effect/vitest'
import { expect } from 'vitest'
import { AgentRevoked } from '../src/AgentRevoked.rejection.ts'
import { CurrentActor } from '../src/CurrentActor.context.ts'
import { ExpiryNotInFuture } from '../src/ExpiryNotInFuture.rejection.ts'
import { GrantExpired } from '../src/GrantExpired.rejection.ts'
import { AcceptProposal } from '../src/Job/AcceptProposal.command.ts'
import { DigestMismatch } from '../src/Job/DigestMismatch.rejection.ts'
import { AlreadyReviewed, LeaveReview, ReviewLeft } from '../src/Job/LeaveReview.command.ts'
import { NoProposal } from '../src/Job/NoProposal.rejection.ts'
import { PostRequest } from '../src/Job/PostRequest.command.ts'
import { ReceiptMismatch } from '../src/Job/ReceiptMismatch.rejection.ts'
import { RecordDelivery } from '../src/Job/RecordDelivery.command.ts'
import { RecordFunding } from '../src/Job/RecordFunding.command.ts'
import { AlreadyRuled, RecordRuling, RulingRecorded } from '../src/Job/RecordRuling.command.ts'
import { JobSettled, RecordSettlement } from '../src/Job/RecordSettlement.command.ts'
import { RecordRejection, RejectionRecorded } from '../src/Job/RecordRejection.command.ts'
import { DeliveryRejected, RejectDelivery } from '../src/Job/RejectDelivery.command.ts'
import { RequestChange } from '../src/Job/RequestChange.command.ts'
import { DeliveryLate, SubmitDelivery } from '../src/Job/SubmitDelivery.command.ts'
import { SelfBid, StaleHead, SubmitProposal } from '../src/Job/SubmitProposal.command.ts'
import { SupersededVersion } from '../src/Job/SupersededVersion.rejection.ts'
import { WrongState } from '../src/Job/WrongState.rejection.ts'
import { MissingScope } from '../src/MissingScope.rejection.ts'
import { NotPermitted } from '../src/NotPermitted.rejection.ts'
import { PartyRequired } from '../src/PartyRequired.rejection.ts'
import { PersonRequired } from '../src/PersonRequired.rejection.ts'
import { SystemOnly } from '../src/SystemOnly.rejection.ts'
import {
  agentOf,
  alice,
  aliceAgent,
  artifactHash,
  at,
  bob,
  bobAgent,
  carol,
  deliveredOnChain,
  digestV1,
  digestV2,
  history,
  iso,
  job,
  jobId,
  person,
  posted,
  proposal1,
  proposal2,
  receipt,
  request,
  settlement,
  story,
  termsV1,
  termsV2,
} from './fixtures.ts'

const acceptV2 = new AcceptProposal({ bidder: bob, version: 2, termsDigest: digestV2 })
const url = 'https://files.example/logo.zip'
const settled = new JobSettled({ buyer: alice, worker: bob, outcome: 'paid', receipts: [receipt('capture')] })

describe('a job refuses', () => {
  it.effect('a request that expires on arrival', () =>
    story(
      Story.provide(CurrentActor, person(alice)),
      Story.when(job, new PostRequest({ ...request, expiresAt: at.start })),
      Story.rejected(new ExpiryNotInFuture({ expiresAt: at.start, now: at.start })),
    ),
  )

  it.effect('a request posted twice', () =>
    story(
      Story.given(job, posted),
      Story.provide(CurrentActor, person(alice)),
      Story.when(job, new PostRequest({ ...request, expiresAt: at.requestExpiry })),
      Story.rejected(new WrongState({ state: 'Open', expected: ['Unposted'] })),
    ),
  )

  it.effect('a self-bid, and a version that does not follow the bidder’s own head', () =>
    story(
      Story.given(job, ...history.open),
      Story.provide(CurrentActor, person(alice)),
      Story.when(job, new SubmitProposal({ proposal: proposal1, terms: termsV1 })),
      Story.rejected(new SelfBid({ bidder: alice })),
      Story.provide(CurrentActor, person(bob)),
      Story.when(job, new SubmitProposal({ proposal: proposal1, terms: termsV1 })),
      Story.rejected(new StaleHead({ head: 2, previous: null })),
      Story.when(job, new SubmitProposal({ proposal: proposal2, previous: 1, terms: termsV2 })),
      Story.rejected(new StaleHead({ head: 2, previous: 1 })),
      Story.provide(CurrentActor, person(carol)),
      Story.when(job, new SubmitProposal({ proposal: proposal1, previous: 1, terms: termsV1 })),
      Story.rejected(new StaleHead({ head: null, previous: 1 })),
    ),
  )

  it.effect('accepting or asking to change anything but the bidder’s head version and its exact digest', () =>
    story(
      Story.given(job, ...history.open),
      Story.provide(CurrentActor, person(alice)),
      Story.when(job, new AcceptProposal({ bidder: bob, version: 1, termsDigest: digestV1 })),
      Story.rejected(new SupersededVersion({ bidder: bob, head: 2, named: 1 })),
      Story.when(job, new AcceptProposal({ bidder: bob, version: 2, termsDigest: digestV1 })),
      Story.rejected(new DigestMismatch({ bidder: bob, version: 2, head: digestV2, named: digestV1 })),
      Story.when(job, new AcceptProposal({ bidder: carol, version: 1, termsDigest: digestV1 })),
      Story.rejected(new NoProposal({ bidder: carol })),
      Story.when(job, new RequestChange({ bidder: bob, version: 1, termsDigest: digestV1 })),
      Story.rejected(new SupersededVersion({ bidder: bob, head: 2, named: 1 })),
    ),
  )

  it.effect('anyone but the buyer accepting, and agents without a live grant that covers the command', () =>
    story(
      Story.given(job, ...history.open),
      Story.provide(CurrentActor, person(carol)),
      Story.when(job, acceptV2),
      Story.rejected(new NotPermitted({ account: carol, required: 'buyer' })),
      Story.provide(CurrentActor, agentOf(alice, aliceAgent, ['discuss', 'propose'])),
      Story.when(job, acceptV2),
      Story.rejected(new MissingScope({ agent: aliceAgent, scope: 'accept' })),
      Story.provide(CurrentActor, agentOf(alice, aliceAgent, ['accept'], { revoked: true })),
      Story.when(job, acceptV2),
      Story.rejected(new AgentRevoked({ agent: aliceAgent })),
      Story.provide(CurrentActor, agentOf(alice, aliceAgent, ['accept'], { expiresAt: at.start })),
      Story.when(job, acceptV2),
      Story.rejected(new GrantExpired({ agent: aliceAgent, expiresAt: at.start, now: at.start })),
      Story.provide(CurrentActor, settlement),
      Story.when(job, acceptV2),
      Story.rejected(new PartyRequired({ system: 'settlement' })),
    ),
  )

  it.effect('chain reports from anyone but the system, and a funding receipt that does not match the agreement', () =>
    story(
      Story.given(job, ...history.awarded),
      Story.provide(CurrentActor, person(alice)),
      Story.when(job, new RecordFunding({ receipt: receipt('authorize') })),
      Story.rejected(new SystemOnly({ account: alice })),
      Story.provide(CurrentActor, settlement),
      Story.when(job, new RecordFunding({ receipt: receipt('authorize', '250000000') })),
      Story.rejected(new ReceiptMismatch({ field: 'amount', expected: '300000000', observed: '250000000' })),
      Story.when(job, new RecordFunding({ receipt: receipt('capture') })),
      Story.rejected(new ReceiptMismatch({ field: 'operation', expected: 'authorize', observed: 'capture' })),
      Story.when(job, new RecordDelivery({ artifactHash, deliveredAt: at.deliveredOnChain })),
      Story.rejected(new WrongState({ state: 'Awarded', expected: ['Funded'] })),
    ),
  )

  it.effect('delivery by anyone but the worker or after the deadline, and paying out undelivered work', () =>
    story(
      Story.given(job, ...history.funded),
      Story.provide(CurrentActor, agentOf(carol, bobAgent, ['deliver'])),
      Story.when(job, new SubmitDelivery({ artifactHash, url })),
      Story.rejected(new NotPermitted({ account: carol, required: 'worker' })),
      Story.clock(iso(at.deliveryDeadline + 1)),
      Story.provide(CurrentActor, person(bob)),
      Story.when(job, new SubmitDelivery({ artifactHash, url })),
      Story.rejected(new DeliveryLate({ deadline: at.deliveryDeadline, now: at.deliveryDeadline + 1 })),
      Story.provide(CurrentActor, settlement),
      Story.when(job, new RecordSettlement({ receipts: [receipt('capture')] })),
      Story.rejected(new ReceiptMismatch({ field: 'operation', expected: 'void or reclaim', observed: 'capture' })),
    ),
  )

  it.effect("a rejection's reason from an agent, from the worker, before delivery, and a second one", () =>
    story(
      Story.given(job, ...history.funded),
      Story.provide(CurrentActor, person(alice)),
      Story.when(job, new RejectDelivery({ reason: 'Nothing yet.' })),
      Story.rejected(new WrongState({ state: 'Funded', expected: ['Delivered', 'Disputed'] })),
      Story.given(job, deliveredOnChain),
      Story.provide(CurrentActor, agentOf(alice, aliceAgent, ['discuss', 'accept'])),
      Story.when(job, new RejectDelivery({ reason: 'Missing files.' })),
      Story.rejected(new PersonRequired({ agent: aliceAgent })),
      Story.provide(CurrentActor, person(bob)),
      Story.when(job, new RejectDelivery({ reason: 'Missing files.' })),
      Story.rejected(new NotPermitted({ account: bob, required: 'buyer' })),
      // The chain recorded the rejection before the buyer said why: the reason may still follow, once.
      Story.provide(CurrentActor, settlement),
      Story.when(job, new RecordRejection({ rejectedAt: at.reviewEnds - 60 })),
      Story.then(
        job,
        new RejectionRecorded({ rejectedAt: at.reviewEnds - 60, arbitrationEndsAt: at.reviewEnds - 60 + 9 * 86_400 }),
      ),
      Story.provide(CurrentActor, person(alice)),
      Story.when(job, new RejectDelivery({ reason: 'Missing files.' })),
      Story.then(job, new DeliveryRejected({ reason: 'Missing files.' })),
      Story.when(job, new RejectDelivery({ reason: 'Changed my mind.' })),
      Story.then(job),
      Story.state(job, (state) => expect(state).toMatchObject({ _tag: 'Disputed', reason: 'Missing files.' })),
    ),
  )

  it.effect('a rejection the chain reports for a job not delivered, and one from a person', () =>
    story(
      Story.given(job, ...history.funded),
      Story.provide(CurrentActor, settlement),
      Story.when(job, new RecordRejection({ rejectedAt: at.reviewEnds })),
      Story.rejected(new WrongState({ state: 'Funded', expected: ['Delivered'] })),
      Story.provide(CurrentActor, person(alice)),
      Story.when(job, new RecordRejection({ rejectedAt: at.reviewEnds })),
      Story.rejected(new SystemOnly({ account: alice })),
    ),
  )

  it.effect('a ruling outside a dispute, and a second ruling', () =>
    story(
      Story.given(job, ...history.delivered),
      Story.provide(CurrentActor, settlement),
      Story.when(job, new RecordRuling({ workerShareBps: 10_000 })),
      Story.rejected(new WrongState({ state: 'Delivered', expected: ['Disputed'] })),
      Story.when(job, new RecordRejection({ rejectedAt: at.reviewEnds - 60 })),
      Story.then(
        job,
        new RejectionRecorded({ rejectedAt: at.reviewEnds - 60, arbitrationEndsAt: at.reviewEnds - 60 + 9 * 86_400 }),
      ),
      Story.when(job, new RecordRuling({ workerShareBps: 0 })),
      Story.then(job, new RulingRecorded({ workerShareBps: 0, ruling: 'refund' })),
      Story.when(job, new RecordRuling({ workerShareBps: 10_000 })),
      Story.rejected(new AlreadyRuled({ workerShareBps: 0 })),
    ),
  )

  it.effect('a review before settlement', () =>
    story(
      Story.given(job, ...history.delivered),
      Story.provide(CurrentActor, person(alice)),
      Story.when(job, new LeaveReview({ rating: 5 })),
      Story.rejected(new WrongState({ state: 'Delivered', expected: ['Settled'] })),
    ),
  )

  it.effect('a review from a stranger, or a second one from the same side', () =>
    story(
      Story.given(job, ...history.delivered, settled),
      Story.provide(CurrentActor, person(carol)),
      Story.when(job, new LeaveReview({ rating: 1 })),
      Story.rejected(new NotPermitted({ account: carol, required: 'party' })),
      Story.provide(CurrentActor, person(bob)),
      Story.when(job, new LeaveReview({ rating: 5 })),
      Story.then(job, new ReviewLeft({ review: { job: jobId, author: bob, subject: alice, rating: 5 } })),
      Story.when(job, new LeaveReview({ rating: 1 })),
      Story.rejected(new AlreadyReviewed({ author: bob })),
    ),
  )
})
