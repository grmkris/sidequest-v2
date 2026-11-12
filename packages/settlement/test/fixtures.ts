import {
  AccountId,
  type Agreement,
  Amount,
  Digest,
  JobId,
  ProposalId,
  type Terms,
  UsdcOnArcTestnet,
} from '@sidequest/protocol'
import { type Address, getAddress } from 'viem'
import { arcTestnet, type SettlementChain } from '../src/SettlementChain.ts'
import vectors from './fixtures/vectors.json' with { type: 'json' }

/** The parties of the typical vector: who pays, who is paid, who arbitrates. */
export const payer: Address = getAddress('0x00000000000000000000000000000000000a11ce')
export const receiver: Address = getAddress('0x0000000000000000000000000000000000000b0b')
export const arbitrator: Address = getAddress('0x00000000000000000000000000000000000a4b17')

/** The chain the vectors were computed on: Arc testnet's id, with the escrow, token and operator the script deployed. */
export const vectorChain: SettlementChain = {
  ...arcTestnet({
    operator: vectors.deployment.operator,
    feeReceiver: vectors.deployment.feeReceiver,
    arbitrator,
    feeBps: vectors.deployment.feeBps,
    confirmations: 3,
  }),
  chainId: vectors.deployment.chainId,
  escrow: getAddress(vectors.deployment.escrow),
  collector: getAddress(vectors.deployment.collector),
  token: getAddress(vectors.deployment.token),
  tokenDomain: { name: 'USD Coin', version: '1' },
}

const day = 24 * 60 * 60

/** The typical vector's terms: 250 USDC, due 2027-01-01, three days' review, two of dispute, seven of arbitration. */
export const terms = (overrides: Partial<Terms> = {}): Terms => ({
  title: 'A logo for a café',
  deliverables: ['SVG logo'],
  amount: Amount.make('250000000'),
  asset: UsdcOnArcTestnet.id,
  network: UsdcOnArcTestnet.network,
  deliveryDeadline: 1_798_761_600,
  reviewWindowSeconds: 3 * day,
  disputeWindowSeconds: 2 * day,
  arbitrationWindowSeconds: 7 * day,
  rail: 'escrow',
  ...overrides,
})

/** The typical vector's agreement. Its terms digest is the vector's, as the operator stores it. */
export const agreement = (overrides: Partial<Terms> = {}): Agreement => ({
  job: JobId.make('job_01JCXZ4Q6N8M2V7T3R5W9Y0B1A'),
  buyer: AccountId.make('account_01JCXZ4Q6N8M2V7T3R5W9Y0B1A'),
  worker: AccountId.make('account_01JCXZ4Q6N8M2V7T3R5W9Y0B1B'),
  proposal: ProposalId.make('proposal_01JCXZ4Q6N8M2V7T3R5W9Y0B1A'),
  version: 1,
  terms: terms(overrides),
  termsDigest: Digest.make('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'),
})

export { vectors }
