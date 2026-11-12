import type { Agreement, Digest, EscrowStage, EscrowStatus, Receipt } from '@sidequest/protocol'
import type { DeadlineCall } from './Settlement.external.ts'

/** A fact the chain established that the job has yet to record, in the order the job must record them. */
export type Report =
  | { readonly kind: 'Funding'; readonly receipt: Receipt }
  | { readonly kind: 'Delivery'; readonly artifactHash: Digest; readonly deliveredAt: number }
  | { readonly kind: 'Rejection'; readonly rejectedAt: number }
  | { readonly kind: 'Ruling'; readonly workerShareBps: number }
  | { readonly kind: 'Settlement'; readonly receipts: readonly [Receipt, ...Array<Receipt>] }

/**
 * Everything `status` shows, as reports, earliest first. A job settled straight from funding (refunded undelivered,
 * or reclaimed) has no delivery to report; a ruling is reported before the settlement it caused.
 */
export const reportsOf = (status: EscrowStatus): ReadonlyArray<Report> => {
  const { funding, delivery, rejection, settlement } = status
  return [
    ...(funding === null ? [] : [{ kind: 'Funding' as const, receipt: funding }]),
    ...(delivery === null
      ? []
      : [{ kind: 'Delivery' as const, artifactHash: delivery.deliveryHash, deliveredAt: delivery.deliveredAt }]),
    ...(rejection === null ? [] : [{ kind: 'Rejection' as const, rejectedAt: rejection.rejectedAt }]),
    ...(settlement?.outcome === 'Ruled'
      ? [{ kind: 'Ruling' as const, workerShareBps: settlement.workerShareBps }]
      : []),
    ...(settlement === null ? [] : [{ kind: 'Settlement' as const, receipts: settlement.receipts }]),
  ]
}

/**
 * The deadline of the stage the payment is in, and the call that settles it once passed: undelivered work is refunded
 * at the delivery deadline, silence is acceptance at the end of the review window, and a dispute nobody ruled on is
 * refunded at the end of the arbitration window. Before funding, the delivery deadline is when funding becomes
 * impossible; it has no call.
 */
export const deadlineOf = (
  agreement: Agreement,
  status: EscrowStatus,
): { readonly at: number; readonly call?: DeadlineCall } | undefined => {
  switch (status.stage) {
    case 'Unfunded':
      return { at: agreement.terms.deliveryDeadline }
    case 'Funded':
      return { at: agreement.terms.deliveryDeadline, call: 'refundUndelivered' }
    case 'Delivered':
      return status.delivery === null ? undefined : { at: status.delivery.reviewEndsAt, call: 'settleAfterReview' }
    case 'Disputed':
      return status.rejection === null ? undefined : { at: status.rejection.arbitrationEndsAt, call: 'settleUnruled' }
    case 'Settled':
      return undefined
  }
}

/** Where the saga stands between two looks at the chain. */
export interface Progress {
  /** The stage the last look showed. */
  readonly stage: EscrowStage
  /** How many looks in a row found that stage while something was in flight: the backoff's exponent. */
  readonly attempt: number
  /** Something is in flight for this stage (the buyer's funding signature, or a deadline call). */
  readonly pending: boolean
  /** How many reports the job has recorded, in `reportsOf` order. */
  readonly recorded: number
}

/** Where the saga starts: the buyer's funding signature was just relayed. */
export const started: Progress = { stage: 'Unfunded', attempt: 0, pending: true, recorded: 0 }

/** The progress after a look that found `stage`, and sent a deadline call if `called`. */
export const after = (progress: Progress, stage: EscrowStage, called: boolean, recorded: number): Progress =>
  stage === progress.stage
    ? { stage, attempt: progress.pending ? progress.attempt + 1 : 0, pending: progress.pending || called, recorded }
    : { stage, attempt: 0, pending: called, recorded }

export interface Timing {
  readonly pollMillis: number
  readonly maxPollMillis: number
  readonly idleMillis: number
}

/** The wait after `attempt` looks that found nothing new: doubling from `pollMillis`, at most `maxPollMillis`. */
export const backoff = (timing: Timing, attempt: number) =>
  Math.min(timing.pollMillis * 2 ** Math.min(attempt, 30), timing.maxPollMillis)

/**
 * How long to wait before the next look: soon while something is in flight, otherwise until the stage's deadline,
 * and never longer than the idle interval (a person's step confirms itself, see `ConfirmSubmission`; the idle look
 * picks up the deadline it moved). Past a deadline whose call has not settled the job, the backoff paces the retries.
 */
export const wakeAfter = (timing: Timing, progress: Progress, deadline: number | undefined, chainTime: number) => {
  const base = progress.pending ? backoff(timing, progress.attempt) : timing.idleMillis
  if (deadline === undefined) return base
  const untilDeadline = (deadline - chainTime) * 1000
  return untilDeadline > 0 ? Math.min(base, untilDeadline) : backoff(timing, progress.attempt)
}
