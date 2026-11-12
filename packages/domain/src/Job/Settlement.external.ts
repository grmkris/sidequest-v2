import * as Domain from '@alchemy.run/domain'
import { Agreement, Bytes32, EscrowStatus } from '@sidequest/protocol'
import { Schema } from 'effect'

/** A deadline function of the escrow's operator, which anyone may call once its time has come. */
export const DeadlineCall = Schema.Literals(['refundUndelivered', 'settleAfterReview', 'settleUnruled'])
export type DeadlineCall = typeof DeadlineCall.Type

/** How a deadline call went: sent in a transaction, or not sent (the chain refused it in simulation, or was out of reach). */
export const CallResult = Schema.Union([
  Schema.TaggedStruct('Sent', { transactionHash: Bytes32 }),
  Schema.TaggedStruct('NotSent', { reason: Schema.String }),
])
export type CallResult = typeof CallResult.Type

/**
 * The escrow, as the settlement saga reaches it. `observe` is the independent chain reader: every fact about the
 * job's payment at the confirmation depth, verified field by field against the agreement, or null when the chain
 * cannot be read just now. `trigger` relays a deadline function; it signs nothing for anyone, and the operator accepts
 * it only once the deadline has passed. Each `attempt` is its own transaction, so a retry is not stuck on one that
 * reverted; the same attempt again is the same transaction. Both answer what happened rather than fail, so the saga
 * decides what to do next.
 */
export class Settlement extends Domain.ExternalSystem('Settlement', {
  observe: { args: { agreement: Agreement }, success: Schema.NullOr(EscrowStatus) },
  trigger: { args: { agreement: Agreement, call: DeadlineCall, attempt: Schema.Int }, success: CallResult },
}) {}
