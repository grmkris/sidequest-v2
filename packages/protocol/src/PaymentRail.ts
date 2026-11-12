import { Schema } from 'effect'

/** How an agreement is paid. Phase 1 has only the escrow rail; `x402` and `direct` come later. */
export const PaymentRail = Schema.Literal('escrow')
export type PaymentRail = typeof PaymentRail.Type
