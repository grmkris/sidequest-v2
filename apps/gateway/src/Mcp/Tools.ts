import { OpenJob } from '@sidequest/fold/api'
import { JobView, Stage } from '@sidequest/fold'
import { EventId, PublicKey } from '@sidequest/nostr'
import {
  AccountRef,
  AgentGrantView,
  Bytes32,
  Cursor,
  IndexListing,
  EscrowPaymentStatus,
  Page,
  Person,
  reading,
  Terms,
  Text,
  ToolLimit,
  TypedData,
  UnixSeconds,
  WalletAddress,
  writing,
  X402PaymentPayload,
} from '@sidequest/protocol'
import { Schema } from 'effect'
import { Tool, Toolkit } from 'effect/ai'
import { GrantRefusalReason } from '../Grants/GrantGate.ts'
import { roomTools } from './RoomTools.ts'

/**
 * Why a tool refused. The grant gate's reasons; the agent's own rate limit; what the gateway checks before it signs
 * (`UnknownJob`, `UnknownProposal`, `NotTheBuyer`, `NotYourProposal`, `NotTheWorker`, `OwnRequest`,
 * `NoWalletOnNetwork`); and the core's refusals (`CoreRefused`, with `core` carrying the core's own error and reason)
 * or its silence (`CoreUnavailable`). `KeyUnavailable`: the agent's key could not be opened (it was deleted). The x402
 * tools' own: no such listing (`UnknownListing`), an escrow listing (`NotPayPerCall`), a payTo that is not the seller's
 * verified wallet (`PayToNotLinked`), a resource that did not answer or is not a public https URL
 * (`ResourceUnreachable`), an answer that was not a 402 with a readable x402 v2 challenge (`NoChallenge`), and a
 * challenge that asks other than its listing (`ChallengeMismatch`, its reason in `detail`).
 */
export const RefusalReason = Schema.Literals([
  ...GrantRefusalReason.literals,
  'RateLimited',
  'UnknownJob',
  'UnknownPerson',
  'UnknownProposal',
  'NotTheBuyer',
  'NotYourProposal',
  'NotTheWorker',
  'OwnRequest',
  'NoWalletOnNetwork',
  'CoreRefused',
  'CoreUnavailable',
  'KeyUnavailable',
  'UnknownListing',
  'NotPayPerCall',
  'PayToNotLinked',
  'ResourceUnreachable',
  'NoChallenge',
  'ChallengeMismatch',
])
export type RefusalReason = typeof RefusalReason.Type

/** The core's own refusal, as a tool answers it: its error's tag, and its reason and detail where it has them. */
const CoreRefusal = Schema.Struct({
  refusal: Schema.String,
  reason: Schema.optionalKey(Schema.String),
  detail: Schema.optionalKey(Schema.String),
})

export class Refused extends Schema.TaggedError<Refused>()('Refused', {
  reason: RefusalReason,
  detail: Schema.optionalKey(Schema.String),
  core: Schema.optionalKey(CoreRefusal),
}) {}

const onJob = { job: EventId.annotate({ description: 'The job’s id: its request event’s id (64 hex).' }) }

/** What a signed event the agent published answers: its id, the key that signed it and the grant it names. */
const Signed = { signedBy: PublicKey, grant: EventId }

const WhoAmI = Tool.make('whoami', {
  description:
    'Who you are: your own Nostr public key (you sign as it), the operator whose grant lets you act, and that grant ' +
    '(scopes, window, the grant event every event you sign names). Needs an active grant, no scope.',
  success: Schema.Struct({ agent: PublicKey, operator: PublicKey, grant: AgentGrantView }),
  failure: Refused,
}).annotateMerge(reading)

const SearchListings = Tool.make('search_listings', {
  description:
    'Search sellers’ listings (NIP-99), newest first: `text` in a title or summary, `tag` one topic exactly. Pass ' +
    '`next` back as `cursor` for the following page. A price on a listing is a hint; nothing binds. No scope.',
  parameters: Schema.Struct({
    text: Schema.optionalKey(Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(100))),
    tag: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40), Schema.isLowercased())),
    limit: Schema.optionalKey(ToolLimit),
    cursor: Schema.optionalKey(Cursor),
  }),
  success: Page(IndexListing),
  failure: Refused,
}).annotateMerge(reading)

const ListOpenRequests = Tool.make('list_open_requests', {
  description:
    'List open work requests, newest first: not funded, not withdrawn, not expired. Pass `next` back as `cursor` ' +
    'for the following page. No scope.',
  parameters: Schema.Struct({ limit: Schema.optionalKey(ToolLimit), cursor: Schema.optionalKey(Cursor) }),
  success: Page(OpenJob),
  failure: Refused,
}).annotateMerge(reading)

const GetJob = Tool.make('get_job', {
  description:
    'Read one job as the index folds it from signed events and the chain: its stage, the request, every proposal ' +
    'and accept with their labels, and, once funded, the chain’s facts. No scope.',
  parameters: Schema.Struct(onJob),
  success: Schema.Struct({ job: JobView }),
  failure: Refused,
}).annotateMerge(reading)

const GetPerson = Tool.make('get_person', {
  description:
    'Read what the index knows of a Nostr key: profile, relays, verified wallets, the grants it gave and received. ' +
    'No scope.',
  parameters: Schema.Struct({ pubkey: PublicKey }),
  success: Schema.Struct({ person: Person }),
  failure: Refused,
}).annotateMerge(reading)

const PaymentStatus = Tool.make('payment_status', {
  description:
    'Read where a job’s escrow payment stands on chain: funded, delivered, rejected or settled, and what the ' +
    'relayer sent. No scope.',
  parameters: Schema.Struct(onJob),
  success: Schema.Struct({ payment: EscrowPaymentStatus }),
  failure: Refused,
}).annotateMerge(reading)

const binds =
  'Nothing you sign binds anyone: a proposal is an offer, and only the buyer’s wallet funding the escrow makes a ' +
  'job real. You never pay and never sign with a wallet.'

const Propose = Tool.make('propose', {
  description:
    `Offer terms on an open request, signed with your key and naming your grant. To revise, name your current ` +
    `proposal as \`previous\`. Payment goes to your operator’s verified wallet on the terms’ network (refused if ` +
    `they have none). Amounts are integer strings in the asset’s smallest unit (USDC: 6 decimals). ${binds} ` +
    'Needs the `propose` scope.',
  parameters: Schema.Struct({
    ...onJob,
    terms: Terms,
    validUntil: UnixSeconds.annotate({ description: 'When the offer lapses, in Unix seconds.' }),
    previous: Schema.optionalKey(
      EventId.annotate({ description: 'Your operator’s proposal (yours, or theirs) this one replaces.' }),
    ),
  }),
  success: Schema.Struct({ job: EventId, proposal: EventId, payTo: AccountRef, ...Signed }),
  failure: Refused,
}).annotateMerge(writing())

const WithdrawProposal = Tool.make('withdraw_proposal', {
  description:
    'Withdraw one of your operator’s proposals (yours, theirs or another of their agents’) with a statement saying why. A buyer could still fund it on chain; your ' +
    `operator’s remedy is then not to deliver, and the escrow refunds. ${binds} Needs the \`propose\` scope.`,
  parameters: Schema.Struct({ ...onJob, proposal: EventId, text: Text(4000) }),
  success: Schema.Struct({ job: EventId, statement: EventId, ...Signed }),
  failure: Refused,
}).annotateMerge(writing({ idempotent: true }))

const Accept = Tool.make('accept', {
  description:
    'For a request your operator posted, sign an accept of one proposal, naming its exact terms. Under your grant ' +
    'the job’s fold counts it as your operator’s accept (the job moves to `accepted`) while the grant holds; it is ' +
    'still only a signal: your operator funds from their own wallet. Answers what the fold shows. ' +
    `${binds} Needs the \`accept\` scope.`,
  parameters: Schema.Struct({ ...onJob, proposal: EventId }),
  success: Schema.Struct({
    job: EventId,
    accept: EventId,
    ...Signed,
    fold: Schema.Struct({ stage: Stage, fromBuyer: Schema.Boolean, matchesProposal: Schema.Boolean }),
  }),
  failure: Refused,
}).annotateMerge(writing({ destructive: true }))

/** Your key's EVM address, which an operator's wallet names to delegate a job's delivery to you. */
const Delegate = WalletAddress.annotate({
  description: 'Your key’s EVM address: the `delegate` your operator’s wallet names in a `DeliveryDelegate`.',
})

export const howToDelegate =
  'To let you record a job’s delivery on chain yourself, your operator’s wallet (the job’s receiver) signs, once, ' +
  'the typed data at `GET <core>/api/index/jobs/<job>/delivery-delegation?delegate=<your delegate>&expiry=<unix ' +
  'seconds>`, and stores that signature at the gateway with `POST /api/agents/<you>/delegations` ({ job, signature, ' +
  'expiry }). It lets your key record that one job’s delivery until the expiry, and nothing else.'

/** The delivery was recorded on chain with your key's signature, under your operator wallet's delegation. */
const DeliveredByDelegate = Schema.Struct({
  signer: Schema.Literal('agent-delegate'),
  delegate: Delegate,
  delegationExpiry: UnixSeconds,
  transactionHash: Bytes32,
})

/** Recording the delivery on chain waits for your operator's wallet. */
const AwaitingWallet = Schema.Struct({
  signer: Schema.Literal('operator-wallet'),
  typedData: TypedData,
  submit: Schema.String,
  explanation: Schema.String,
  delegation: Schema.Struct({
    delegate: Delegate,
    /** Whether the gateway holds a delegation for this job (an expired one counts as none). */
    held: Schema.Boolean,
    /** Why the core refused to relay the delivery under the delegation the gateway holds, if it did. */
    refusal: Schema.optionalKey(CoreRefusal),
    howTo: Schema.String,
  }),
})

const Deliver = Tool.make('deliver', {
  description:
    'On a funded job whose worker is your operator (you, or they, made the funded proposal), publish a delivery ' +
    'note: the delivery’s hash (0x and 64 hex) ' +
    'and where to fetch it. If your operator delegated this job’s delivery to your key (see `delivery_delegation`), ' +
    'your key also records the delivery on chain, unattended (`onChain.signer` is `agent-delegate`). Otherwise ' +
    'recording it needs your operator’s WALLET signature, which you do not have: the answer carries the EIP-712 ' +
    'typed data your operator must sign and submit, and how they could delegate instead. Until one of them happens, ' +
    `the escrow sees no delivery. ${binds} Needs the \`deliver\` scope.`,
  parameters: Schema.Struct({
    ...onJob,
    deliveryHash: Bytes32,
    url: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^https:\/\/\S{1,2000}$/u))),
    note: Schema.optionalKey(Text(4000)),
  }),
  success: Schema.Struct({
    job: EventId,
    note: EventId,
    ...Signed,
    onChain: Schema.Union([DeliveredByDelegate, AwaitingWallet]),
  }),
  failure: Refused,
}).annotateMerge(writing())

const DeliveryDelegation = Tool.make('delivery_delegation', {
  description:
    'Whether you hold your operator’s delegation to record a job’s delivery on chain with your own key, until ' +
    'when, and your delegate address (your key’s EVM address) for them to name. The delegation covers that one job ' +
    'and only recording its delivery: never approving, rejecting, refunding or moving money. No scope.',
  parameters: Schema.Struct(onJob),
  success: Schema.Struct({
    job: EventId,
    delegate: Delegate,
    held: Schema.Boolean,
    expiry: Schema.NullOr(UnixSeconds),
    howTo: Schema.String,
  }),
  failure: Refused,
}).annotateMerge(reading)

const onListing = {
  seller: PublicKey.annotate({ description: 'The listing’s seller: their Nostr public key (64 hex).' }),
  slug: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/u)).annotate({
    description: 'The listing’s slug (its `d` tag).',
  }),
}

const noRefunds =
  'A paid call has no escrow, no review, no dispute and no refund: once your operator’s wallet signs, the seller ' +
  'can take the money whether or not the call works. Sidequest holds nothing and is not in the payment path.'

/** A pay-per-call listing's terms as the tools state them. */
const PaidListing = Schema.Struct({
  seller: PublicKey,
  slug: Schema.String,
  version: EventId,
  resource: Schema.String,
  amount: Schema.String,
  asset: Schema.String,
  payTo: AccountRef,
})

const X402Quote = Tool.make('x402_quote', {
  description:
    'For a pay-per-call (x402) listing: ask its resource for its price (an unpaid request, answered 402), check ' +
    'that the challenge asks exactly what the listing says (the seller’s verified wallet as payTo, the price, the ' +
    'asset and network), and answer what your OPERATOR’S WALLET must sign to pay one call (ERC-3009 ' +
    '`TransferWithAuthorization` typed data) and the unsigned x402 payment. You cannot pay: you hold no money and ' +
    'never sign with a wallet. Your operator signs `typedData`, puts the signature in `payment.payload.signature`, ' +
    'and calls the resource with the payment, base64 JSON, in the `PAYMENT-SIGNATURE` header before `validBefore`; ' +
    `then \`x402_receipt\` records it. ${noRefunds} No scope.`,
  parameters: Schema.Struct(onListing),
  success: Schema.Struct({
    listing: PaidListing,
    payer: AccountRef,
    typedData: TypedData,
    payment: X402PaymentPayload,
    validBefore: UnixSeconds,
    warning: Schema.String,
  }),
  failure: Refused,
}).annotateMerge(reading)

const X402Receipt = Tool.make('x402_receipt', {
  description:
    'After your operator’s wallet paid a call to a pay-per-call listing, publish the receipt: the listing, the ' +
    'wallet that paid (your operator’s verified wallet on the price’s network), the price and the settlement ' +
    'transaction (the `transaction` of the seller’s `PAYMENT-RESPONSE`). Signed with your key under your grant. The ' +
    'index labels it verified once the chain shows that transfer, confirmed, from your operator’s wallet to the ' +
    'listing’s payTo; a wrong claim stays unverified. Needs the `accept` scope.',
  parameters: Schema.Struct({ ...onListing, transaction: Bytes32 }),
  success: Schema.Struct({ receipt: EventId, listing: PaidListing, payer: AccountRef, ...Signed }),
  failure: Refused,
}).annotateMerge(writing({ idempotent: true }))

/** Every tool an agent reaches at the gateway's `/mcp`. */
export const GatewayToolkit = Toolkit.make(
  WhoAmI,
  SearchListings,
  ListOpenRequests,
  GetJob,
  GetPerson,
  PaymentStatus,
  Propose,
  WithdrawProposal,
  Accept,
  Deliver,
  DeliveryDelegation,
  X402Quote,
  X402Receipt,
  ...roomTools,
)
