import { EventId } from '@sidequest/nostr'
import { AccountRef, Amount, AssetId, Bps, Bytes32, Digest, UnixSeconds } from '@sidequest/protocol'
import { Schema } from 'effect'

const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))

/** Where a log sits on chain: its block and its index in that block. Orders chain facts among themselves. */
export const LogPosition = Schema.Struct({ block: Count, logIndex: Count })
export type LogPosition = typeof LogPosition.Type

/**
 * Every fact names the escrow payment it is about by `paymentHash`, the escrow's `PaymentInfo` hash, which keys the job
 * in `SidequestOperator` and in `AuthCaptureEscrow`. Only `JobFunded` also names the job, so the fold reaches every
 * later fact through the funding's payment hash.
 */
const located = { at: LogPosition, paymentHash: Bytes32 }

/**
 * `SidequestOperator.JobFunded`: the buyer's authorisation landed in the escrow. `job` is the `bytes32 jobId` read back
 * as the request event's id (`jobOfWord`), `termsDigest` the `bytes32` as hex without `0x`, `payer` and `receiver` the
 * payment's addresses as CAIP-10 on the job's network, `asset` the token as CAIP-19 and `amount` the payment's
 * `maxAmount`. The windows and deadlines are the job parameters the operator stored.
 */
export const ChainFunded = Schema.TaggedStruct('Funded', {
  ...located,
  job: EventId,
  termsDigest: Digest,
  payer: AccountRef,
  receiver: AccountRef,
  asset: AssetId,
  amount: Amount,
  deliveryDeadline: UnixSeconds,
  reviewWindowSeconds: Count,
  disputeWindowSeconds: Count,
  arbitrationWindowSeconds: Count,
  arbitrator: AccountRef,
  authorizationExpiry: UnixSeconds,
})
export type ChainFunded = typeof ChainFunded.Type

/** `SidequestOperator.JobDelivered`: the receiver posted the delivery hash; the review window runs to `reviewEndsAt`. */
export const ChainDelivered = Schema.TaggedStruct('Delivered', {
  ...located,
  deliveryHash: Bytes32,
  deliveredAt: UnixSeconds,
  reviewEndsAt: UnixSeconds,
})
export type ChainDelivered = typeof ChainDelivered.Type

/** `SidequestOperator.JobRejected`: the payer's signed rejection; the arbitrator may rule until `arbitrationEndsAt`. */
export const ChainRejected = Schema.TaggedStruct('Rejected', {
  ...located,
  rejectedAt: UnixSeconds,
  arbitrationEndsAt: UnixSeconds,
})
export type ChainRejected = typeof ChainRejected.Type

/** The operator's `Outcome` for a settled job, as `JobSettled` emits it (its `None` is never emitted). */
export const OperatorOutcome = Schema.Literals(['Approved', 'AcceptedBySilence', 'Ruled', 'Unruled', 'Undelivered'])
export type OperatorOutcome = typeof OperatorOutcome.Type

/**
 * `SidequestOperator.JobSettled`: the terminal outcome. `capturedAmount` (including `feeAmount`) went to the receiver
 * and the fee receiver, `refundedAmount` was voided back to the payer.
 */
export const ChainSettled = Schema.TaggedStruct('Settled', {
  ...located,
  outcome: OperatorOutcome,
  workerShareBps: Bps,
  capturedAmount: Amount,
  feeAmount: Amount,
  refundedAmount: Amount,
  settledAt: UnixSeconds,
})
export type ChainSettled = typeof ChainSettled.Type

/**
 * `AuthCaptureEscrow.PaymentReclaimed`: the payer took the whole authorisation back after `authorizationExpiry`. The
 * escrow logs no time, so `reclaimedAt` is the log's block timestamp. The operator's own job is left as it was.
 */
export const ChainReclaimed = Schema.TaggedStruct('Reclaimed', {
  ...located,
  amount: Amount,
  reclaimedAt: UnixSeconds,
})
export type ChainReclaimed = typeof ChainReclaimed.Type

/** One verified chain log about a job's escrow payment, as plain data. */
export const ChainFact = Schema.Union([ChainFunded, ChainDelivered, ChainRejected, ChainSettled, ChainReclaimed])
export type ChainFact = typeof ChainFact.Type

/** How a job's escrow ended: the operator's settlement or the escrow's own reclaim. */
export const ChainEnding = Schema.Union([ChainSettled, ChainReclaimed])
export type ChainEnding = typeof ChainEnding.Type

/** Chain order: by block, then by log index. */
export const comparePositions = (left: LogPosition, right: LogPosition): number =>
  left.block === right.block ? left.logIndex - right.logIndex : left.block - right.block
