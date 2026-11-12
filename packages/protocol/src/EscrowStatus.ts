import { Schema } from 'effect'
import { Bytes32 } from './Bytes32.ts'
import { Digest } from './Digest.ts'
import { Bps } from './JobView.ts'
import { Receipt } from './Receipt.ts'
import { UnixSeconds } from './UnixSeconds.ts'

/** How `SidequestOperator` settled a job: its `Outcome`, plus the escrow's own `reclaim` by the payer. */
export const ChainOutcome = Schema.Literals([
  'Approved',
  'AcceptedBySilence',
  'Ruled',
  'Unruled',
  'Undelivered',
  'Reclaimed',
])
export type ChainOutcome = typeof ChainOutcome.Type

/** Where the job's escrow payment is on chain, counting only events at the required confirmation depth. */
export const EscrowStage = Schema.Literals(['Unfunded', 'Funded', 'Delivered', 'Disputed', 'Settled'])
export type EscrowStage = typeof EscrowStage.Type

/**
 * An event the chain reader could not verify. `inconclusive`: a field it needs is missing or unreadable.
 * `receipt_mismatch`: a field differs from the agreement. Either way the event counts for nothing.
 */
export const ChainProblem = Schema.Struct({
  event: Schema.String,
  kind: Schema.Literals(['inconclusive', 'receipt_mismatch']),
  field: Schema.String,
  expected: Schema.String,
  observed: Schema.String,
})
export type ChainProblem = typeof ChainProblem.Type

/** The delivery hash the worker posted on chain, and the review window it started. */
export const ChainDelivery = Schema.Struct({
  deliveryHash: Digest,
  deliveredAt: UnixSeconds,
  reviewEndsAt: UnixSeconds,
  transactionHash: Bytes32,
})
export type ChainDelivery = typeof ChainDelivery.Type

/** The buyer's rejection on chain, and the time the arbitrator has to rule. */
export const ChainRejection = Schema.Struct({
  rejectedAt: UnixSeconds,
  arbitrationEndsAt: UnixSeconds,
  transactionHash: Bytes32,
})
export type ChainRejection = typeof ChainRejection.Type

/** The terminal outcome on chain, with the capture and void receipts it produced. */
export const ChainSettlement = Schema.Struct({
  outcome: ChainOutcome,
  workerShareBps: Bps,
  settledAt: UnixSeconds,
  receipts: Schema.NonEmptyArray(Receipt),
})
export type ChainSettlement = typeof ChainSettlement.Type

/**
 * What the chain reader verified about one job's escrow payment: each fact found at the confirmation depth and checked
 * field by field against the agreement. `chainTime` is the timestamp of the newest block at that depth; deadlines are
 * judged against it. `paymentHash` is null until the buyer asked to fund.
 */
export const EscrowStatus = Schema.Struct({
  paymentHash: Schema.NullOr(Bytes32),
  chainTime: UnixSeconds,
  stage: EscrowStage,
  funding: Schema.NullOr(Receipt),
  delivery: Schema.NullOr(ChainDelivery),
  rejection: Schema.NullOr(ChainRejection),
  settlement: Schema.NullOr(ChainSettlement),
  problems: Schema.Array(ChainProblem),
})
export type EscrowStatus = typeof EscrowStatus.Type
