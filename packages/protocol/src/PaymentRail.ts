import { Schema } from 'effect'

/** How a job's terms are paid. Only the escrow rail exists; `x402` and `direct` come later. */
export const PaymentRail = Schema.Literal('escrow')
export type PaymentRail = typeof PaymentRail.Type
