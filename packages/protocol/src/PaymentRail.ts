import { Schema } from 'effect'

/**
 * How a job's terms are paid: only through the escrow. x402 is a listing's rail (`ListingRail`, ADR-0006), a single
 * paid call that never makes a job, so it is deliberately not a job's rail; `direct` comes later.
 */
export const PaymentRail = Schema.Literal('escrow')
export type PaymentRail = typeof PaymentRail.Type
