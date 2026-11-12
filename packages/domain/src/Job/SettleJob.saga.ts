import * as Domain from '@alchemy.run/domain'
import { Agreement, JobId } from '@sidequest/protocol'
import { Effect } from 'effect'
import { DurableDeferred } from 'effect/workflow'
import { after, backoff, deadlineOf, type Progress, reportsOf, started, wakeAfter } from './SettlementPlan.ts'
import { settlementSteps } from './SettlementSteps.ts'
import { SettlementTiming } from './SettlementTiming.ts'

/** The buyer's signed funding authorization went to the chain: the saga starts looking. */
export const FundingSubmitted = DurableDeferred.make('FundingSubmitted')

/**
 * Keeps one awarded job in step with its escrow until the chain settles it. The chain is the authority: the saga
 * reports to the job only what the chain reader verified (`RecordFunding`, `RecordDelivery`, `RecordRejection`,
 * `RecordRuling`, `RecordSettlement`), and it sends the deadline calls anyone may send when they are due:
 * `refundUndelivered` at the delivery deadline, `settleAfterReview` at the end of the review window (a missed one
 * lets the buyer reclaim delivered work once the escrow expires), `settleUnruled` at the end of the arbitration
 * window. A call that fails is logged for an alert and retried, backing off, until the chain shows the job settled.
 *
 * It waits for the buyer's funding signature, then looks at the chain until funding shows. From then on it sleeps
 * until the stage's deadline, looking at least every idle interval, since each person's later step (delivery,
 * approval, rejection, ruling) is confirmed by its own `ConfirmSubmission` run and moves the next deadline.
 */
export class SettleJob extends Domain.Saga('SettleJob', { key: JobId, input: { agreement: Agreement } }) {}

export const SettleJobLive = SettleJob.toLayer(
  Effect.gen(function* () {
    const steps = yield* settlementSteps
    const timing = yield* SettlementTiming

    /** One look at the chain: record what is new, send the call that is due. Done once nothing more can happen. */
    const look = Effect.fnUntraced(function* (job: JobId, agreement: Agreement, progress: Progress, round: number) {
      const status = yield* steps.observe(`observe-${round}`, agreement)
      // The chain cannot be read just now: look again, backing off further each time it stays out of reach.
      if (status === null)
        return {
          done: false,
          progress: { ...progress, attempt: progress.attempt + 1 },
          millis: backoff(timing, progress.attempt),
        }
      const reports = reportsOf(status)
      yield* Effect.forEach(
        reports.slice(progress.recorded),
        (report, offset) => steps.record(`record-${progress.recorded + offset}-${report.kind}`, job, report),
        { discard: true },
      )
      const deadline = deadlineOf(agreement, status)
      const passed = deadline !== undefined && status.chainTime >= deadline.at
      // Settled, or never funded by the time funding became impossible: nothing more can happen on chain.
      const done = deadline === undefined || (deadline.call === undefined && passed)
      const due = passed && !done ? deadline.call : undefined
      if (due !== undefined) yield* steps.trigger(`trigger-${round}-${due}`, agreement, due, round)
      const next = after(progress, status.stage, due !== undefined, reports.length)
      return { done, progress: next, millis: wakeAfter(timing, next, deadline?.at, status.chainTime) }
    })

    return Effect.fn(function* ({ key, agreement }: { readonly key: JobId; readonly agreement: Agreement }) {
      yield* DurableDeferred.await(FundingSubmitted)
      let progress = started
      for (let round = 0, done = false; !done; round += 1) {
        const looked = yield* look(key, agreement, progress, round)
        done = looked.done
        progress = looked.progress
        if (!done) yield* steps.sleep(`sleep-${round}`, looked.millis)
      }
    })
  }),
)
