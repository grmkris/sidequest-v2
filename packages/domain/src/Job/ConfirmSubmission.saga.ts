import * as Domain from '@alchemy.run/domain'
import { Agreement, EscrowStage } from '@sidequest/protocol'
import { Effect, Schema } from 'effect'
import { backoff, reportsOf } from './SettlementPlan.ts'
import { settlementSteps } from './SettlementSteps.ts'
import { SettlementTiming } from './SettlementTiming.ts'

/** How many looks a confirmation makes before it leaves the rest to the job's {@link SettleJob} run. */
export const confirmationLooks = 8

/**
 * Confirms one step a person took on chain (the worker's delivery, the buyer's approval or rejection, the
 * arbitrator's ruling) as soon as the chain shows it: after the server relayed the signature, it looks at the chain,
 * backing off, until the payment has left the stage `from`, and reports every verified fact to the job. The job's
 * `SettleJob` run would report them too, at its next look; this only makes the job follow within seconds. If the
 * chain never shows the step (the transaction reverted), it stops after {@link confirmationLooks} looks. Keyed by job
 * and step, so a second submission of the same step is the same run.
 */
export class ConfirmSubmission extends Domain.Saga('ConfirmSubmission', {
  key: Schema.String,
  input: { agreement: Agreement, from: EscrowStage },
}) {}

export const ConfirmSubmissionLive = ConfirmSubmission.toLayer(
  Effect.gen(function* () {
    const steps = yield* settlementSteps
    const timing = yield* SettlementTiming
    return Effect.fn(function* ({ agreement, from }: { readonly agreement: Agreement; readonly from: EscrowStage }) {
      let recorded = 0
      for (let look = 0; look < confirmationLooks; look += 1) {
        yield* steps.sleep(`sleep-${look}`, backoff(timing, look))
        const status = yield* steps.observe(`observe-${look}`, agreement)
        if (status === null) continue
        const reports = reportsOf(status)
        yield* Effect.forEach(
          reports.slice(recorded),
          (report, offset) => steps.record(`record-${recorded + offset}-${report.kind}`, agreement.job, report),
          { discard: true },
        )
        recorded = reports.length
        if (status.stage !== from) return
      }
    })
  }),
)
