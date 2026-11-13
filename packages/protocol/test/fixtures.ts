import { Schema } from 'effect'
import { Terms } from '../src/Terms.ts'

/** Terms in their encoded form, as a client sends them. */
export const encodedTerms = {
  title: 'Logo für Café ☕',
  deliverables: ['SVG logo', 'Brand sheet (PDF)'],
  amount: '250000000',
  asset: 'eip155:5042002/erc20:0x3600000000000000000000000000000000000000',
  network: 'eip155:5042002',
  deliveryDeadline: 1798761600,
  reviewWindowSeconds: 259200,
  disputeWindowSeconds: 172800,
  arbitrationWindowSeconds: 604800,
  rail: 'escrow',
} as const

export const terms = Schema.decodeSync(Terms)(encodedTerms)
