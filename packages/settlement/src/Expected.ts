import type { Agreement } from '@sidequest/protocol'
import type { Payment } from './Payment.ts'
import type { SettlementChain } from './SettlementChain.ts'

/**
 * What the chain must show for one job: the agreement, the exact payment built from it for the agreed parties, the
 * chain it settles on, and the block to read its events from (the head when the buyer asked to fund).
 */
export interface Expected {
  readonly agreement: Agreement
  readonly payment: Payment
  readonly chain: SettlementChain
  readonly fromBlock: bigint
}
