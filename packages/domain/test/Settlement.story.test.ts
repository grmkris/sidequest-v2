import { Story } from '@alchemy.run/domain/Story'
import { describe, it } from '@effect/vitest'
import type { EscrowStatus } from '@sidequest/protocol'
import { Layer } from 'effect'
import { CurrentActor } from '../src/CurrentActor.context.ts'
import { AcceptProposal } from '../src/Job/AcceptProposal.command.ts'
import { RejectionRecorded } from '../src/Job/RecordRejection.command.ts'
import { RulingRecorded } from '../src/Job/RecordRuling.command.ts'
import { JobSettled } from '../src/Job/RecordSettlement.command.ts'
import { Settlement } from '../src/Job/Settlement.external.ts'
import { SettlementTiming } from '../src/Job/SettlementTiming.ts'
import { FundingSubmitted, SettleJob } from '../src/Job/SettleJob.saga.ts'
import { Sidequest, SidequestHandlers } from '../src/Sidequest.model.ts'
import {
  accepted,
  agreement,
  alice,
  artifactHash,
  at,
  bob,
  deliveredOnChain,
  digestV2,
  funded,
  history,
  iso,
  job,
  jobId,
  memoryStores,
  person,
  receipt,
} from './fixtures.ts'

// The settlement saga against a scripted chain: each `observe` is answered with what the chain reader would verify,
// each deadline call with whether it went out. The story clock follows the chain's time, as it does in production.

const day = 24 * 60 * 60
const minute = 60_000
/** Stories where the saga looks at least every `idleDays`. */
const storyLooking = (idleDays: number) =>
  Story.make(Sidequest, {
    layer: SidequestHandlers.pipe(
      Layer.provide(
        Layer.mergeAll(
          memoryStores().layer,
          Layer.succeed(SettlementTiming, {
            pollMillis: minute,
            maxPollMillis: 60 * minute,
            idleMillis: idleDays * day * 1000,
          }),
        ),
      ),
    ),
    externalSystems: [Settlement],
  })
const story = storyLooking(2)

const tx = (digit: string) => `0x${digit.repeat(64)}`
const fundedAt = at.deliveredOnChain - 2 * day
const delivered = at.deliveredOnChain + 60 // when the saga's look after funding sees the delivery
const reviewEnds = at.reviewEnds
const rejectedAt = reviewEnds - day
const arbitrationEnds = rejectedAt + 2 * day + 7 * day
const onChain = {
  delivery: {
    deliveryHash: artifactHash,
    deliveredAt: at.deliveredOnChain,
    reviewEndsAt: reviewEnds,
    transactionHash: tx('4'),
  },
  rejection: { rejectedAt, arbitrationEndsAt: arbitrationEnds, transactionHash: tx('5') },
}

/** What the chain reader verified at `chainTime`, in `stage`, with the facts that stage implies. */
const status = (chainTime: number, stage: EscrowStatus['stage'], facts: Partial<EscrowStatus> = {}): EscrowStatus => ({
  paymentHash: tx('1'),
  chainTime,
  stage,
  funding: stage === 'Unfunded' ? null : receipt('authorize'),
  delivery: stage === 'Delivered' || stage === 'Disputed' ? onChain.delivery : null,
  rejection: stage === 'Disputed' ? onChain.rejection : null,
  settlement: null,
  problems: [],
  ...facts,
})

const settled = (chainTime: number, settlement: EscrowStatus['settlement'], facts: Partial<EscrowStatus> = {}) =>
  status(chainTime, 'Settled', { delivery: onChain.delivery, settlement, ...facts })
const paid = (outcome: 'Approved' | 'AcceptedBySilence') =>
  ({ outcome, workerShareBps: 10_000, settledAt: reviewEnds, receipts: [receipt('capture')] }) as const
const refunded = (outcome: 'Unruled' | 'Undelivered', settledAt: number) =>
  ({ outcome, workerShareBps: 0, settledAt, receipts: [receipt('void')] }) as const
const jobPaid = new JobSettled({ buyer: alice, worker: bob, outcome: 'paid', receipts: [receipt('capture')] })
const jobRefunded = new JobSettled({ buyer: alice, worker: bob, outcome: 'refunded', receipts: [receipt('void')] })
const completed = Story.saga(SettleJob, jobId, { _tag: 'Completed', result: undefined })

/** The saga looks at the chain when its clock reaches `answer.chainTime`, and the reader answers `answer`. */
const look = (answer: EscrowStatus) => [
  Story.clock(iso(answer.chainTime)),
  Story.expectCall(Settlement.observe, { agreement }),
  Story.resolve(Settlement.observe, answer),
]

/** The saga sends `call`, and it goes out or not. */
const call = (name: 'refundUndelivered' | 'settleAfterReview' | 'settleUnruled', sent: boolean) => [
  Story.expectCall(Settlement.trigger, { agreement, call: name }),
  Story.resolve(
    Settlement.trigger,
    sent ? { _tag: 'Sent', transactionHash: tx('6') } : { _tag: 'NotSent', reason: 'TooEarly' },
  ),
]

/** The buyer accepts; the saga waits for the funding signature, then sees the job funded on chain. */
const fundedJob = [
  Story.given(job, ...history.open),
  Story.clock(iso(fundedAt - 60)),
  Story.provide(CurrentActor, person(alice)),
  Story.when(job, new AcceptProposal({ bidder: bob, version: 2, termsDigest: digestV2 })),
  Story.then(job, accepted),
  Story.saga(SettleJob, jobId, { _tag: 'Running' }),
  Story.signal(SettleJob, jobId, FundingSubmitted, undefined),
  ...look(status(fundedAt, 'Funded')),
  Story.then(job, funded),
]

/** …and, at its next look, the worker's delivery. */
const deliveredJob = [...fundedJob, ...look(status(delivered, 'Delivered')), Story.then(job, deliveredOnChain)]

describe('the settlement saga', () => {
  it.effect('records funding, delivery and the approval as the chain shows them, then completes', () =>
    story(
      ...deliveredJob,
      ...look(settled(delivered + 2 * day, paid('Approved'))),
      Story.then(job, jobPaid),
      completed,
    ),
  )

  it.effect('after silence, sends settleAfterReview at the end of the review window and records the capture', () =>
    story(
      ...deliveredJob,
      ...look(status(delivered + 2 * day, 'Delivered')),
      ...look(status(reviewEnds, 'Delivered')),
      ...call('settleAfterReview', true),
      ...look(settled(reviewEnds + 60, paid('AcceptedBySilence'))),
      Story.then(job, jobPaid),
      completed,
    ),
  )

  it.effect('retries a deadline call that failed, backing off, until the chain shows the job settled', () =>
    story(
      ...deliveredJob,
      ...look(status(delivered + 2 * day, 'Delivered')),
      ...look(status(reviewEnds, 'Delivered')),
      ...call('settleAfterReview', false),
      ...look(status(reviewEnds + 60, 'Delivered')),
      ...call('settleAfterReview', false),
      ...look(status(reviewEnds + 180, 'Delivered')),
      ...call('settleAfterReview', true),
      ...look(settled(reviewEnds + 420, paid('AcceptedBySilence'))),
      Story.then(job, jobPaid),
      completed,
    ),
  )

  it.effect("records a rejection, then the arbitrator's split and the settlement it caused", () => {
    const split = [receipt('capture', '180000000'), receipt('void', '120000000')] as const
    return story(
      ...deliveredJob,
      ...look(status(delivered + 2 * day, 'Disputed')),
      Story.then(job, new RejectionRecorded({ rejectedAt, arbitrationEndsAt: arbitrationEnds })),
      ...look(
        settled(
          delivered + 4 * day,
          { outcome: 'Ruled', workerShareBps: 6000, settledAt: delivered + 3 * day, receipts: split },
          { rejection: onChain.rejection },
        ),
      ),
      Story.then(job, new RulingRecorded({ workerShareBps: 6000, ruling: 'split' })),
      Story.then(job, new JobSettled({ buyer: alice, worker: bob, outcome: 'split', receipts: split })),
      completed,
    )
  })

  it.effect('refunds a dispute nobody ruled on at the end of the arbitration window', () =>
    story(
      ...deliveredJob,
      ...look(status(delivered + 2 * day, 'Disputed')),
      Story.then(job, new RejectionRecorded({ rejectedAt, arbitrationEndsAt: arbitrationEnds })),
      ...[4, 6, 8, 10].flatMap((days) => look(status(delivered + days * day, 'Disputed'))),
      ...look(status(arbitrationEnds, 'Disputed')),
      ...call('settleUnruled', true),
      ...look(
        settled(arbitrationEnds + 60, refunded('Unruled', arbitrationEnds + 30), { rejection: onChain.rejection }),
      ),
      Story.then(job, jobRefunded),
      completed,
    ),
  )

  it.effect('refunds undelivered work at the delivery deadline', () =>
    storyLooking(400)(
      ...fundedJob,
      ...look(status(at.deliveryDeadline, 'Funded')),
      ...call('refundUndelivered', true),
      ...look(
        status(at.deliveryDeadline + 60, 'Settled', { settlement: refunded('Undelivered', at.deliveryDeadline + 30) }),
      ),
      Story.then(job, jobRefunded),
      completed,
    ),
  )

  it.effect('records nothing until the chain shows it, and waits out a chain it cannot read', () =>
    story(
      Story.given(job, ...history.open),
      Story.clock(iso(fundedAt - 600)),
      Story.provide(CurrentActor, person(alice)),
      Story.when(job, new AcceptProposal({ bidder: bob, version: 2, termsDigest: digestV2 })),
      Story.then(job, accepted),
      Story.signal(SettleJob, jobId, FundingSubmitted, undefined),
      Story.expectCall(Settlement.observe, { agreement }),
      Story.resolve(Settlement.observe, null),
      // The signature was relayed, but the chain shows no funding yet: the job stays awarded.
      ...look(status(fundedAt - 540, 'Unfunded')),
      Story.then(job),
      ...look(status(fundedAt, 'Funded')),
      Story.then(job, funded),
      Story.saga(SettleJob, jobId, { _tag: 'Running' }),
    ),
  )

  it.effect('ends without a call when the job was never funded by its delivery deadline', () =>
    storyLooking(400)(
      Story.given(job, ...history.open),
      Story.provide(CurrentActor, person(alice)),
      Story.when(job, new AcceptProposal({ bidder: bob, version: 2, termsDigest: digestV2 })),
      Story.then(job, accepted),
      Story.signal(SettleJob, jobId, FundingSubmitted, undefined),
      ...look(status(at.deliveryDeadline, 'Unfunded')),
      Story.then(job),
      completed,
    ),
  )
})
