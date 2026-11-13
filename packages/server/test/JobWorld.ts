import { ChainFact } from '@sidequest/fold'
import { type NostrEvent, publicKeyOf, type SecretKey } from '@sidequest/nostr'
import {
  buildSidequestEvent,
  deliveryNote,
  jobAccept,
  jobProposal,
  jobRequest,
  type KindSpec,
  serviceListingTemplate,
  ServiceListing,
  statement,
  type StatementType,
} from '@sidequest/nostr/vocabulary'
import { type NetworkRef, Terms, termsDigest, UsdcOnArcTestnet } from '@sidequest/protocol'
import { Effect, Schema } from 'effect'
import { signed } from './IndexWorld.ts'

// Signed job events, listings and chain facts for the index's job and listing tests: the same vocabulary a client
// uses, signed with the index tests' fixed keys.

const day = 86_400
const arc = UsdcOnArcTestnet.network

/** A key's wallet on Arc testnet as a CAIP-10 account: a fixed address per key, lowercase as links carry it. */
export const walletOfKey = (key: SecretKey) => `${arc}:0x${publicKeyOf(key).slice(0, 40)}`

/** Terms in USDC on Arc testnet, due ten days after `from`. */
export const termsFrom = (from: number, amount = '120000000') =>
  Schema.decodeSync(Terms)({
    title: 'Translate the onboarding guide',
    deliverables: ['Slovenian translation'],
    amount,
    asset: UsdcOnArcTestnet.id,
    network: arc,
    deliveryDeadline: from + 10 * day,
    reviewWindowSeconds: day,
    disputeWindowSeconds: day,
    arbitrationWindowSeconds: 2 * day,
    rail: 'escrow',
  })

const build = <C>(spec: KindSpec<C>, content: unknown, key: SecretKey, createdAt: number, network?: NetworkRef) =>
  Effect.runPromise(
    Schema.decodeUnknownEffect(spec.content)(content).pipe(
      Effect.flatMap((decoded) =>
        buildSidequestEvent(spec, decoded, network === undefined ? { createdAt } : { createdAt, network }),
      ),
      Effect.map((template) => signed(template, key)),
    ),
  )

/** A request by `key`, expiring `expiresIn` seconds after it is signed. */
export const requestBy = (key: SecretKey, createdAt: number, expiresIn = 7 * day, title = 'Translate our guide') =>
  build(jobRequest, { title, description: 'Into Slovenian.', expiresAt: createdAt + expiresIn }, key, createdAt)

/** `key`'s proposal for `job` to its buyer, paying `key`'s wallet, valid for three days. */
export const proposalBy = async (
  key: SecretKey,
  job: NostrEvent,
  createdAt: number,
  offered = termsFrom(createdAt),
  payTo = walletOfKey(key),
) =>
  build(
    jobProposal,
    {
      job: job.id,
      buyer: job.pubkey,
      terms: Schema.encodeSync(Terms)(offered),
      termsDigest: await Effect.runPromise(termsDigest(offered)),
      payTo,
      validUntil: createdAt + 3 * day,
    },
    key,
    createdAt,
  )

const ProposalJson = Schema.fromJsonString(
  Schema.Struct({ job: Schema.String, termsDigest: Schema.String, payTo: Schema.String }),
)
const payToOf = (proposal: NostrEvent) => Schema.decodeUnknownSync(ProposalJson)(proposal.content).payTo

/** The terms digest a proposal binds. */
export const digestOf = (proposal: NostrEvent) => Schema.decodeUnknownSync(ProposalJson)(proposal.content).termsDigest

/** `key` accepts `proposal`. */
export const acceptBy = (key: SecretKey, proposal: NostrEvent, createdAt: number) =>
  build(
    jobAccept,
    {
      job: Schema.decodeUnknownSync(ProposalJson)(proposal.content).job,
      proposal: proposal.id,
      termsDigest: digestOf(proposal),
      worker: proposal.pubkey,
    },
    key,
    createdAt,
    arc,
  )

/** `key` says something about `job`. */
export const statementBy = (key: SecretKey, job: string, type: StatementType, createdAt: number, about?: string) =>
  build(statement, { job, type, text: 'On the record.', ...(about === undefined ? {} : { about }) }, key, createdAt)

/** `key`'s delivery note for `job` to its buyer. */
export const noteBy = (key: SecretKey, job: NostrEvent, createdAt: number, deliveryHash: string) =>
  build(deliveryNote, { job: job.id, buyer: job.pubkey, deliveryHash }, key, createdAt, arc)

/** `key`'s NIP-99 listing under `slug`, signed at `createdAt`. */
export const listingBy = (
  key: SecretKey,
  slug: string,
  createdAt: number,
  fields: { readonly title?: string; readonly summary?: string; readonly topics?: ReadonlyArray<string> } = {},
  priced = true,
) =>
  signed(
    serviceListingTemplate(
      Schema.decodeUnknownSync(ServiceListing)({
        slug,
        title: fields.title ?? `Translation ${slug}`,
        summary: fields.summary ?? 'English to Slovenian, fast.',
        description: 'I translate guides.',
        topics: fields.topics ?? ['translation'],
        ...(priced ? { price: { amount: '50000000', asset: UsdcOnArcTestnet.id } } : {}),
        status: 'active',
        publishedAt: createdAt,
      }),
      createdAt,
    ),
    key,
  )

const payment = (seed: string) => `0x${seed.repeat(32)}`
const transaction = (seed: string) => `0x${seed.repeat(32)}`

/** `JobFunded` for `proposal`'s job and terms, paid by the `payer` account to the proposal's `payTo`, at `block`. */
export const fundedFact = (
  proposal: NostrEvent,
  payer: string,
  block: number,
  offered: Terms,
  paymentSeed = 'cd',
): ChainFact =>
  Schema.decodeUnknownSync(ChainFact)({
    _tag: 'Funded',
    at: { block, logIndex: 0 },
    paymentHash: payment(paymentSeed),
    job: Schema.decodeUnknownSync(ProposalJson)(proposal.content).job,
    termsDigest: digestOf(proposal),
    payer,
    receiver: payToOf(proposal),
    asset: offered.asset,
    amount: offered.amount,
    deliveryDeadline: offered.deliveryDeadline,
    reviewWindowSeconds: offered.reviewWindowSeconds,
    disputeWindowSeconds: offered.disputeWindowSeconds,
    arbitrationWindowSeconds: offered.arbitrationWindowSeconds,
    arbitrator: `${arc}:0x00000000000000000000000000000000000a4b17`,
    authorizationExpiry: offered.deliveryDeadline + 5 * day,
  })

/** `JobDelivered` on the funding's payment. */
export const deliveredFact = (block: number, deliveredAt: number, deliveryHash: string, paymentSeed = 'cd') =>
  Schema.decodeUnknownSync(ChainFact)({
    _tag: 'Delivered',
    at: { block, logIndex: 0 },
    paymentHash: payment(paymentSeed),
    deliveryHash,
    deliveredAt,
    reviewEndsAt: deliveredAt + day,
  })

/** `JobSettled` as an approval of 120 USDC with a 500 bps fee. */
export const releasedFact = (block: number, settledAt: number, paymentSeed = 'cd') =>
  Schema.decodeUnknownSync(ChainFact)({
    _tag: 'Settled',
    at: { block, logIndex: 1 },
    paymentHash: payment(paymentSeed),
    outcome: 'Approved',
    workerShareBps: 10_000,
    capturedAmount: '120000000',
    feeAmount: '6000000',
    refundedAmount: '0',
    settledAt,
  })

/** A fact as the index records it: on Arc testnet, in a transaction named by `seed`. */
export const onArc = (fact: ChainFact, seed = 'ab') => ({ chain: arc, transactionHash: transaction(seed), fact })
