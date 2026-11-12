import { type Agreement, EscrowStatus, type JobId } from '@sidequest/protocol'
import { Effect, Predicate, Schema } from 'effect'
import { Activity, DurableClock } from 'effect/workflow'
import { system } from '../Actor.ts'
import { CurrentActor } from '../CurrentActor.context.ts'
import type { SystemOnly } from '../SystemOnly.rejection.ts'
import { Job } from './Job.aggregate.ts'
import type { ReceiptMismatch } from './ReceiptMismatch.rejection.ts'
import { RecordDelivery } from './RecordDelivery.command.ts'
import { RecordFunding } from './RecordFunding.command.ts'
import { RecordRejection } from './RecordRejection.command.ts'
import { RecordRuling } from './RecordRuling.command.ts'
import { RecordSettlement } from './RecordSettlement.command.ts'
import { type DeadlineCall, Settlement } from './Settlement.external.ts'
import type { Report } from './SettlementPlan.ts'

const asSettlement = Effect.provideService(CurrentActor, system('settlement'))

/** A report the job holds already (another look recorded it, or a replay after its command committed) changes nothing. */
const held = () => Effect.void
// The settlement saga is the system: refusing it is a broken invariant.
const systemOnly = (rejection: SystemOnly) => Effect.die(rejection)
const mismatched = (job: JobId) => (mismatch: ReceiptMismatch) =>
  Effect.logError('Sidequest.Settlement.receiptMismatch').pipe(
    Effect.annotateLogs({ alert: 'settlement-receipt', job, field: mismatch.field }),
  )

/** A durable sleep: the run is stored and woken when it is over, however long that is. */
const sleep = (name: string, millis: number) => DurableClock.sleep({ name, duration: millis, inMemoryThreshold: 0 })

/**
 * The steps the settlement sagas are made of, each a durable activity named by the caller: look at the chain through
 * the reader, report one verified fact to the job, send one deadline call, sleep.
 */
export const settlementSteps = Effect.gen(function* () {
  const jobs = yield* Job
  const settlement = yield* Settlement

  const observe = (name: string, agreement: Agreement) =>
    Activity.make({
      name,
      success: Schema.NullOr(EscrowStatus),
      execute: settlement
        .observe({ agreement })
        .pipe(
          Effect.tap((status: EscrowStatus | null) =>
            status === null || status.problems.length === 0
              ? Effect.void
              : Effect.logWarning('Sidequest.Settlement.unverifiedFacts').pipe(
                  Effect.annotateLogs({ alert: 'settlement-receipt', job: agreement.job, problems: status.problems }),
                ),
          ),
        ),
    })

  const send = (job: JobId, report: Report) => {
    switch (report.kind) {
      case 'Funding':
        return jobs
          .send(job, new RecordFunding({ receipt: report.receipt }))
          .pipe(
            Effect.asVoid,
            Effect.catchTags({ WrongState: held, ReceiptMismatch: mismatched(job), SystemOnly: systemOnly }),
          )
      case 'Delivery':
        return jobs
          .send(job, new RecordDelivery({ artifactHash: report.artifactHash, deliveredAt: report.deliveredAt }))
          .pipe(Effect.asVoid, Effect.catchTags({ WrongState: held, SystemOnly: systemOnly }))
      case 'Rejection':
        return jobs
          .send(job, new RecordRejection({ rejectedAt: report.rejectedAt }))
          .pipe(Effect.asVoid, Effect.catchTags({ WrongState: held, SystemOnly: systemOnly }))
      case 'Ruling':
        return jobs
          .send(job, new RecordRuling({ workerShareBps: report.workerShareBps }))
          .pipe(Effect.asVoid, Effect.catchTags({ WrongState: held, AlreadyRuled: held, SystemOnly: systemOnly }))
      case 'Settlement':
        return jobs
          .send(job, new RecordSettlement({ receipts: report.receipts }))
          .pipe(
            Effect.asVoid,
            Effect.catchTags({ WrongState: held, ReceiptMismatch: mismatched(job), SystemOnly: systemOnly }),
          )
    }
  }

  /** Reports one fact to the job as the system: the only way a job's money stages move. */
  const record = (name: string, job: JobId, report: Report) =>
    Activity.make({ name, execute: asSettlement(send(job, report)) })

  /** Sends a deadline call; one that does not go out is logged for an alert, and the caller retries. */
  const trigger = (name: string, agreement: Agreement, call: DeadlineCall, attempt: number) =>
    Activity.make({
      name,
      execute: settlement.trigger({ agreement, call, attempt }).pipe(
        Effect.flatMap((result) =>
          Predicate.isTagged(result, 'Sent')
            ? Effect.void
            : Effect.logError('Sidequest.Settlement.deadlineCallFailed').pipe(
                Effect.annotateLogs({
                  alert: 'settlement-deadline',
                  job: agreement.job,
                  call,
                  reason: result.reason,
                }),
              ),
        ),
      ),
    })

  return { observe, record, trigger, sleep }
})
