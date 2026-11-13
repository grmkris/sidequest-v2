import { Entropy, type EventId, finalizeEvent, type PublicKey, publicKeyOf, SecretKey } from '@sidequest/nostr'
import {
  buildSidequestEvent,
  deliveryNote,
  EvmAccount,
  jobAccept,
  jobProposal,
  type JobProposalContent,
  jobRequest,
  jobReview,
  type KindSpec,
  type ParsedEvent,
  parseSidequestEvent,
  statement,
  type StatementType,
} from '@sidequest/nostr/vocabulary'
import { AccountRef, Amount, AssetId, type Bytes32, Digest, NetworkRef, Terms, termsDigest } from '@sidequest/protocol'
import { Effect, Schema } from 'effect'
import type { ChainFact, ChainFunded, LogPosition, OperatorOutcome } from '../src/ChainFacts.ts'
import type { JobEvent, WalletLinkFact } from '../src/JobInput.ts'

/** Every story happens around this instant; `at(offset)` is that many seconds after it. */
const start = 1_800_000_000
export const at = (offset: number) => start + offset
export const hour = 3_600
export const day = 24 * hour

const key = (hex: string) => Schema.decodeSync(SecretKey)(hex.repeat(32))
const zeros = Schema.decodeSync(Entropy)(new Uint8Array(32))

/** The people in the stories: a buyer, a worker, a rival bidder and a stranger. */
export const keys = { buyer: key('11'), worker: key('22'), rival: key('33'), stranger: key('44') }
export type Person = keyof typeof keys
export const pub = (person: Person): PublicKey => publicKeyOf(keys[person])

const arc = NetworkRef.make('eip155:5042002')
const wallet = (address: string) => Schema.decodeSync(EvmAccount)(`${arc}:${address}`)

/** Wallets, lowercase as links carry them. The chain reader writes them checksummed: see `onChain`. */
export const wallets = {
  buyer: wallet('0xabcdef00000000000000000000000000000000b1'),
  worker: wallet('0xabcdef00000000000000000000000000000000b2'),
  rival: wallet('0xabcdef00000000000000000000000000000000b3'),
}
/** A wallet as the chain reader spells it: mixed case. */
export const onChain = (account: EvmAccount) => AccountRef.make(account.replace('0xabcdef', '0xABCdef'))

/** Each person's wallet linked to their key. */
export const links: ReadonlyArray<WalletLinkFact> = [
  { wallet: wallets.buyer, pubkey: pub('buyer') },
  { wallet: wallets.worker, pubkey: pub('worker') },
  { wallet: wallets.rival, pubkey: pub('rival') },
]

export const deliveryDeadline = at(10 * day)
export const terms = Schema.decodeSync(Terms)({
  title: 'Translate the onboarding guide',
  deliverables: ['Slovenian translation'],
  amount: '120000000',
  asset: 'eip155:5042002/erc20:0x3600000000000000000000000000000000000000',
  network: arc,
  deliveryDeadline,
  reviewWindowSeconds: day,
  disputeWindowSeconds: day,
  arbitrationWindowSeconds: 2 * day,
  rail: 'escrow',
})
/** The same work for more money: another terms digest. */
export const dearerTerms = Schema.decodeSync(Terms)({ ...Schema.encodeSync(Terms)(terms), amount: '150000000' })
export const digestOf = (offered: Terms) => Effect.runPromise(termsDigest(offered))

const signed = <C>(spec: KindSpec<C>, content: C, person: Person, createdAt: number, network?: NetworkRef) =>
  Effect.runPromise(
    buildSidequestEvent(spec, content, network === undefined ? { createdAt } : { createdAt, network }).pipe(
      Effect.flatMap((template) => parseSidequestEvent(spec, finalizeEvent(template, keys[person], zeros))),
    ),
  )

/** The buyer's request; it expires a week in. */
export const request = async (createdAt = at(0)) => {
  const content = { title: 'Translate our guide', description: 'Into Slovenian.', expiresAt: at(7 * day) }
  const parsed = await signed(jobRequest, content, 'buyer', createdAt)
  return { type: 'request', parsed } as const satisfies JobEvent
}

export interface ProposalSeed {
  readonly job: EventId
  readonly by: Person
  readonly createdAt: number
  readonly offered?: Terms
  readonly previous?: EventId
}

/** A proposal valid for three days, paying the bidder's own wallet. */
export const proposal = async (seed: ProposalSeed) => {
  const offered = seed.offered ?? terms
  const payTo = AccountRef.make(seed.by === 'rival' ? wallets.rival : wallets.worker)
  const content = {
    job: seed.job,
    buyer: pub('buyer'),
    terms: offered,
    termsDigest: await digestOf(offered),
    payTo,
    validUntil: at(3 * day),
    ...(seed.previous === undefined ? {} : { previous: seed.previous }),
  }
  const parsed = await signed(jobProposal, content, seed.by, seed.createdAt)
  return { type: 'proposal', parsed } as const satisfies JobEvent
}

type Proposal = ParsedEvent<JobProposalContent>

/** An accept of a proposal, by the buyer unless someone else is named. */
export const accept = async (of: Proposal, createdAt: number, by: Person = 'buyer') => {
  const content = {
    job: of.content.job,
    proposal: of.event.id,
    termsDigest: of.content.termsDigest,
    worker: of.event.pubkey,
  }
  const parsed = await signed(jobAccept, content, by, createdAt, arc)
  return { type: 'accept', parsed } as const satisfies JobEvent
}

export const deliveryHash: Bytes32 = `0x${'de'.repeat(32)}`

export const note = async (job: EventId, by: Person, createdAt: number, hash: Bytes32 = deliveryHash) => {
  const content = { job, buyer: pub('buyer'), deliveryHash: hash }
  const parsed = await signed(deliveryNote, content, by, createdAt, arc)
  return { type: 'deliveryNote', parsed } as const satisfies JobEvent
}

export const say = async (job: EventId, by: Person, type: StatementType, createdAt: number, about?: EventId) => {
  const content = { job, type, text: 'On the record.', ...(about === undefined ? {} : { about }) }
  const parsed = await signed(statement, content, by, createdAt)
  return { type: 'statement', parsed } as const satisfies JobEvent
}

export const review = async (job: EventId, by: Person, subject: Person, rating: number, createdAt: number) => {
  const content = { job, subject: pub(subject), rating, text: 'Thanks.' }
  const parsed = await signed(jobReview, content, by, createdAt)
  return { type: 'review', parsed } as const satisfies JobEvent
}

/** The escrow payment of the stories, and another one. */
export const payment: Bytes32 = `0x${'cd'.repeat(32)}`
export const otherPayment: Bytes32 = `0x${'ce'.repeat(32)}`
const position = (block: number, logIndex = 0): LogPosition => ({ block, logIndex })

export interface FundingSeed {
  readonly job: EventId
  readonly termsDigest: string
  readonly receiver?: EvmAccount
  readonly block?: number
  readonly paymentHash?: Bytes32
}

/** `JobFunded` for the stories' terms, by the buyer's wallet to the worker's unless another receiver is named. */
export const funded = (seed: FundingSeed): ChainFunded => ({
  _tag: 'Funded',
  at: position(seed.block ?? 100, 3),
  paymentHash: seed.paymentHash ?? payment,
  job: seed.job,
  termsDigest: Digest.make(seed.termsDigest),
  payer: onChain(wallets.buyer),
  receiver: onChain(seed.receiver ?? wallets.worker),
  asset: AssetId.make(terms.asset),
  amount: Amount.make(terms.amount),
  deliveryDeadline,
  reviewWindowSeconds: day,
  disputeWindowSeconds: day,
  arbitrationWindowSeconds: 2 * day,
  arbitrator: AccountRef.make(`${arc}:0x00000000000000000000000000000000000a4b17`),
  authorizationExpiry: deliveryDeadline + 5 * day,
})

export const delivered = (deliveredAt: number, block = 200): ChainFact => ({
  _tag: 'Delivered',
  at: position(block),
  paymentHash: payment,
  deliveryHash,
  deliveredAt,
  reviewEndsAt: deliveredAt + day,
})

export const rejected = (rejectedAt: number, block = 300): ChainFact => ({
  _tag: 'Rejected',
  at: position(block),
  paymentHash: payment,
  rejectedAt,
  arbitrationEndsAt: rejectedAt + 3 * day,
})

/** `JobSettled` with the operator's amounts for a 500 bps fee. */
export const settled = (
  outcome: OperatorOutcome,
  workerShareBps: number,
  settledAt: number,
  block = 400,
): ChainFact => {
  const captured = (120_000_000n * BigInt(workerShareBps)) / 10_000n
  return {
    _tag: 'Settled',
    at: position(block),
    paymentHash: payment,
    outcome,
    workerShareBps,
    capturedAmount: Amount.make(String(captured)),
    feeAmount: Amount.make(String((captured * 500n) / 10_000n)),
    refundedAmount: Amount.make(String(120_000_000n - captured)),
    settledAt,
  }
}

export const reclaimed = (reclaimedAt: number, block = 500): ChainFact => ({
  _tag: 'Reclaimed',
  at: position(block),
  paymentHash: payment,
  amount: Amount.make(terms.amount),
  reclaimedAt,
})
