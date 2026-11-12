import { AccountId, AgentId, Digest, type GrantScope, JobId, ProposalId, Receipt, Terms } from '@sidequest/protocol'
import { Schema } from 'effect'
import { type Actor, system } from '../src/Actor.ts'
import { ProposalAccepted } from '../src/Job/AcceptProposal.command.ts'
import { Job } from '../src/Job/Job.aggregate.ts'
import { RequestPosted } from '../src/Job/PostRequest.command.ts'
import { FundingRecorded } from '../src/Job/RecordFunding.command.ts'
import { DeliveryRecorded } from '../src/Job/RecordDelivery.command.ts'
import { ProposalSubmitted } from '../src/Job/SubmitProposal.command.ts'

// Instants as Unix seconds. Stories start at 2026-01-01T00:00:00Z.
export const at = {
  start: 1767225600,
  requestExpiry: 1769904000, // 2026-02-01
  deliveredOnChain: 1772323200, // 2026-03-01
  reviewEnds: 1772582400, // 2026-03-04: delivery plus the three-day review window
  grantExpiry: 1796083200, // 2026-12-01
  deliveryDeadline: 1798761600, // 2027-01-01, in the terms
} as const
export const iso = (seconds: number) => new Date(seconds * 1000).toISOString()

export const alice = AccountId.make('account_01JCXZ4Q6N8M2V7T3R5W9Y0B1A') // the buyer
export const bob = AccountId.make('account_01JCXZ4Q6N8M2V7T3R5W9Y0B1B') // the bidder who becomes the worker
export const carol = AccountId.make('account_01JCXZ4Q6N8M2V7T3R5W9Y0B1C') // a stranger to the job
export const aliceAgent = AgentId.make('agent_01JCXZ4Q6N8M2V7T3R5W9Y0B1A')
export const bobAgent = AgentId.make('agent_01JCXZ4Q6N8M2V7T3R5W9Y0B1B')

export const person = (account: AccountId): Actor => ({ account })
export const agentOf = (
  account: AccountId,
  id: AgentId,
  scopes: ReadonlyArray<GrantScope>,
  { expiresAt = at.grantExpiry, revoked = false }: { expiresAt?: number; revoked?: boolean } = {},
): Actor => ({ account, agent: { id, scopes: [...scopes], expiresAt, revoked } })
export const settlement = system('settlement')

const encodedTerms = {
  title: 'Logo für Café ☕',
  deliverables: ['SVG logo', 'Brand sheet (PDF)'],
  amount: '250000000',
  asset: 'eip155:5042002/erc20:0x3600000000000000000000000000000000000000',
  network: 'eip155:5042002',
  deliveryDeadline: at.deliveryDeadline,
  reviewWindowSeconds: 259200,
  disputeWindowSeconds: 172800,
  arbitrationWindowSeconds: 604800,
  rail: 'escrow',
} as const
export const termsV1 = Schema.decodeSync(Terms)(encodedTerms)
export const termsV2 = Schema.decodeSync(Terms)({
  ...encodedTerms,
  deliverables: [...encodedTerms.deliverables, 'Favicon set'],
  amount: '300000000',
})
// Computed independently: sha256(json.dumps(terms, sort_keys=True, separators=(',', ':'), ensure_ascii=False)).
export const digestV1 = Digest.make('3b188db9e0e2d40340b5a1edd1df3f55ab275a1702a8833161232300b1d650e2')
export const digestV2 = Digest.make('c2fc441c098a2637e24b9daeca0182471cfcef25044ad89052d9efcaa55ddd16')
export const artifactHash = Digest.make('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08')

export const jobId = JobId.make('job_01JCXZ4Q6N8M2V7T3R5W9Y0B1D')
export const job = Job.ref(jobId)
export const proposal1 = ProposalId.make('proposal_01JCXZ4Q6N8M2V7T3R5W9Y0B11')
export const proposal2 = ProposalId.make('proposal_01JCXZ4Q6N8M2V7T3R5W9Y0B12')

export const request = { title: 'A logo for my café', description: 'Warm, hand-drawn, works small.' }
export const posted = new RequestPosted({
  request: { id: jobId, buyer: alice, ...request, expiresAt: at.requestExpiry },
})
export const bobV1 = new ProposalSubmitted({
  proposal: { id: proposal1, job: jobId, bidder: bob, version: 1, terms: termsV1, termsDigest: digestV1 },
})
export const bobV2 = new ProposalSubmitted({
  proposal: { id: proposal2, job: jobId, bidder: bob, version: 2, previous: 1, terms: termsV2, termsDigest: digestV2 },
})
export const agreement = {
  job: jobId,
  buyer: alice,
  worker: bob,
  proposal: proposal2,
  version: 2,
  terms: termsV2,
  termsDigest: digestV2,
}
export const accepted = new ProposalAccepted({ agreement })

const bytes32 = (digit: string) => `0x${digit.repeat(64)}`
export const receipt = (operation: Receipt['operation'], amount = '300000000') =>
  Schema.decodeSync(Receipt)({
    job: jobId,
    rail: 'escrow',
    network: 'eip155:5042002',
    operation,
    asset: 'eip155:5042002/erc20:0x3600000000000000000000000000000000000000',
    amount,
    payer: 'eip155:5042002:0x00000000000000000000000000000000000a11ce',
    payee: 'eip155:5042002:0x0000000000000000000000000000000000000b0b',
    paymentHash: bytes32('1'),
    transactionHash: bytes32(operation === 'authorize' ? '2' : '3'),
    status: 'success',
    confirmations: 3,
  })
export const funded = new FundingRecorded({ receipt: receipt('authorize') })
export const deliveredOnChain = new DeliveryRecorded({
  artifactHash,
  deliveredAt: at.deliveredOnChain,
  reviewEndsAt: at.reviewEnds,
})

/** Histories a job reaches, for stories that start part-way through. */
export const history = {
  open: [posted, bobV1, bobV2],
  awarded: [posted, bobV1, bobV2, accepted],
  funded: [posted, bobV1, bobV2, accepted, funded],
  delivered: [posted, bobV1, bobV2, accepted, funded, deliveredOnChain],
}
