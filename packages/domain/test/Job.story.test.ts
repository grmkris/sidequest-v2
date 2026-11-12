import { Story } from '@alchemy.run/domain/Story'
import { describe, it } from '@effect/vitest'
import { expect } from 'vitest'
import { CurrentActor } from '../src/CurrentActor.context.ts'
import { AcceptProposal } from '../src/Job/AcceptProposal.command.ts'
import { ApproveDelivery, DeliveryApproved } from '../src/Job/ApproveDelivery.command.ts'
import { CancelRequest, RequestCancelled } from '../src/Job/CancelRequest.command.ts'
import { ExpireRequest, RequestExpired } from '../src/Job/ExpireRequest.command.ts'
import { LeaveReview, ReviewLeft } from '../src/Job/LeaveReview.command.ts'
import { PostRequest } from '../src/Job/PostRequest.command.ts'
import { RecordDelivery } from '../src/Job/RecordDelivery.command.ts'
import { RecordFunding } from '../src/Job/RecordFunding.command.ts'
import { RecordRuling, RulingRecorded } from '../src/Job/RecordRuling.command.ts'
import { JobSettled, RecordSettlement } from '../src/Job/RecordSettlement.command.ts'
import { DeliveryRejected, RejectDelivery } from '../src/Job/RejectDelivery.command.ts'
import { ChangeRequested, RequestChange } from '../src/Job/RequestChange.command.ts'
import { DeliverySubmitted, SubmitDelivery } from '../src/Job/SubmitDelivery.command.ts'
import { SubmitProposal } from '../src/Job/SubmitProposal.command.ts'
import { WrongState } from '../src/Job/WrongState.rejection.ts'
import { Sidequest } from '../src/Sidequest.model.ts'
import {
  accepted,
  agentOf,
  alice,
  aliceAgent,
  artifactHash,
  at,
  bob,
  bobAgent,
  bobV1,
  bobV2,
  deliveredOnChain,
  digestV1,
  digestV2,
  funded,
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
  termsV1,
  termsV2,
} from './fixtures.ts'

const story = Story.make(Sidequest)
const url = 'https://files.example/logo.zip'
const review = (author: typeof alice, subject: typeof alice, rating: number) =>
  new ReviewLeft({ review: { job: jobId, author, subject, rating } })

describe('a job', () => {
  it.effect('runs from request to reviews: proposals, a change, the accepted version, funding and delivery', () =>
    story(
      Story.provide(CurrentActor, person(alice)),
      Story.when(job, new PostRequest({ ...request, expiresAt: at.requestExpiry })),
      Story.then(job, posted),
      Story.provide(CurrentActor, agentOf(bob, bobAgent, ['propose'])),
      Story.when(job, new SubmitProposal({ proposal: proposal1, terms: termsV1 })),
      Story.then(job, bobV1),
      Story.provide(CurrentActor, person(alice)),
      Story.when(job, new RequestChange({ bidder: bob, version: 1, termsDigest: digestV1 })),
      Story.then(job, new ChangeRequested({ bidder: bob, version: 1, termsDigest: digestV1 })),
      Story.provide(CurrentActor, person(bob)),
      Story.when(job, new SubmitProposal({ proposal: proposal2, previous: 1, terms: termsV2 })),
      Story.then(job, bobV2),
      Story.provide(CurrentActor, agentOf(alice, aliceAgent, ['accept'])),
      Story.when(job, new AcceptProposal({ bidder: bob, version: 2, termsDigest: digestV2 })),
      Story.then(job, accepted),
      Story.provide(CurrentActor, settlement),
      Story.when(job, new RecordFunding({ receipt: receipt('authorize') })),
      Story.then(job, funded),
      Story.clock(iso(at.deliveredOnChain - 3600)),
      Story.provide(CurrentActor, agentOf(bob, bobAgent, ['deliver'])),
      Story.when(job, new SubmitDelivery({ artifactHash, url })),
      Story.then(job, new DeliverySubmitted({ delivery: { job: jobId, artifactHash, url } })),
      Story.provide(CurrentActor, settlement),
      Story.when(job, new RecordDelivery({ artifactHash, deliveredAt: at.deliveredOnChain })),
      Story.then(job, deliveredOnChain),
      Story.clock(iso(at.deliveredOnChain + 3600)),
      Story.provide(CurrentActor, person(alice)),
      Story.when(job, new ApproveDelivery()),
      Story.then(job, new DeliveryApproved({ approvedAt: at.deliveredOnChain + 3600 })),
      // Approving again changes nothing.
      Story.when(job, new ApproveDelivery()),
      Story.then(job),
      Story.provide(CurrentActor, settlement),
      Story.when(job, new RecordSettlement({ receipts: [receipt('capture')] })),
      Story.then(job, new JobSettled({ buyer: alice, worker: bob, outcome: 'paid', receipts: [receipt('capture')] })),
      Story.provide(CurrentActor, person(alice)),
      Story.when(job, new LeaveReview({ rating: 5 })),
      Story.then(job, review(alice, bob, 5)),
      Story.provide(CurrentActor, agentOf(bob, bobAgent, ['discuss'])),
      Story.when(job, new LeaveReview({ rating: 4, comment: 'Clear brief.' })),
      Story.then(
        job,
        new ReviewLeft({ review: { job: jobId, author: bob, subject: alice, rating: 4, comment: 'Clear brief.' } }),
      ),
      Story.state(job, (state) =>
        expect(state).toEqual({ _tag: 'Settled', buyer: alice, worker: bob, reviewed: [alice, bob] }),
      ),
    ),
  )

  it.effect('goes to dispute when the buyer rejects in the review window, and settles as the arbitrator split it', () =>
    story(
      Story.given(job, ...history.delivered),
      Story.clock(iso(at.reviewEnds - 60)),
      Story.provide(CurrentActor, person(alice)),
      Story.when(job, new RejectDelivery({ reason: 'The favicon set is missing.' })),
      Story.then(job, new DeliveryRejected({ reason: 'The favicon set is missing.' })),
      Story.provide(CurrentActor, settlement),
      Story.when(job, new RecordRuling({ workerShareBps: 6000 })),
      Story.then(job, new RulingRecorded({ workerShareBps: 6000, ruling: 'split' })),
      Story.when(
        job,
        new RecordSettlement({ receipts: [receipt('capture', '180000000'), receipt('void', '120000000')] }),
      ),
      Story.then(
        job,
        new JobSettled({
          buyer: alice,
          worker: bob,
          outcome: 'split',
          receipts: [receipt('capture', '180000000'), receipt('void', '120000000')],
        }),
      ),
    ),
  )

  it.effect('refunds the buyer when nothing was delivered by the deadline', () =>
    story(
      Story.given(job, ...history.funded),
      Story.provide(CurrentActor, settlement),
      Story.when(job, new RecordSettlement({ receipts: [receipt('reclaim')] })),
      Story.then(
        job,
        new JobSettled({ buyer: alice, worker: bob, outcome: 'refunded', receipts: [receipt('reclaim')] }),
      ),
      Story.provide(CurrentActor, person(bob)),
      Story.when(job, new SubmitDelivery({ artifactHash, url })),
      Story.rejected(new WrongState({ state: 'Settled', expected: ['Funded'] })),
    ),
  )

  it.effect('lets the buyer cancel an open request, and nothing proceeds after it', () =>
    story(
      Story.given(job, ...history.open),
      Story.provide(CurrentActor, person(alice)),
      Story.when(job, new CancelRequest()),
      Story.then(job, new RequestCancelled()),
      Story.when(job, new CancelRequest()),
      Story.rejected(new WrongState({ state: 'Cancelled', expected: ['Open'] })),
      Story.when(job, new AcceptProposal({ bidder: bob, version: 2, termsDigest: digestV2 })),
      Story.rejected(new WrongState({ state: 'Cancelled', expected: ['Open'] })),
    ),
  )

  it.effect('expires an open request only when the system sends the expiry after it is due', () =>
    story(
      Story.given(job, posted),
      Story.provide(CurrentActor, settlement),
      Story.when(job, new ExpireRequest()),
      Story.then(job),
      Story.clock(iso(at.requestExpiry)),
      // A person cannot expire it, even once it is due; the command records nothing rather than rejecting, so the
      // system can schedule it.
      Story.provide(CurrentActor, person(alice)),
      Story.when(job, new ExpireRequest()),
      Story.then(job),
      Story.provide(CurrentActor, settlement),
      Story.when(job, new ExpireRequest()),
      Story.then(job, new RequestExpired()),
      Story.when(job, new ExpireRequest()),
      Story.then(job),
      Story.provide(CurrentActor, person(bob)),
      Story.when(job, new SubmitProposal({ proposal: proposal1, terms: termsV1 })),
      Story.rejected(new WrongState({ state: 'Expired', expected: ['Open'] })),
    ),
  )

  it.effect('does not expire a request that was awarded before its expiry fired', () =>
    story(
      Story.given(job, ...history.awarded),
      Story.clock(iso(at.requestExpiry + 1)),
      Story.provide(CurrentActor, settlement),
      Story.when(job, new ExpireRequest()),
      Story.then(job),
    ),
  )
})
