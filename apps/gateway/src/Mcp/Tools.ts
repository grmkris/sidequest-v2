import { OpenJob } from '@sidequest/fold/api'
import { JobView, Stage } from '@sidequest/fold'
import { EventId, PublicKey } from '@sidequest/nostr'
import {
  AccountRef,
  AgentGrantView,
  Bytes32,
  Cursor,
  IndexListing,
  IndexPaymentStatus,
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
} from '@sidequest/protocol'
import { Schema } from 'effect'
import { Tool, Toolkit } from 'effect/ai'
import { GrantRefusalReason } from '../Grants/GrantGate.ts'

/**
 * Why a tool refused. The grant gate's reasons; the agent's own rate limit; what the gateway checks before it signs
 * (`UnknownJob`, `UnknownProposal`, `NotTheBuyer`, `NotYourProposal`, `NotTheWorker`, `OwnRequest`,
 * `NoWalletOnNetwork`); and the core's refusals (`CoreRefused`, with `core` carrying the core's own error and reason)
 * or its silence (`CoreUnavailable`). `KeyUnavailable`: the agent's key could not be opened (it was deleted).
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
  success: Schema.Struct({ payment: IndexPaymentStatus }),
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
    previous: Schema.optionalKey(EventId.annotate({ description: 'Your proposal this one replaces.' })),
  }),
  success: Schema.Struct({ job: EventId, proposal: EventId, payTo: AccountRef, ...Signed }),
  failure: Refused,
}).annotateMerge(writing())

const WithdrawProposal = Tool.make('withdraw_proposal', {
  description:
    'Withdraw one of your own proposals with a statement saying why. A buyer could still fund it on chain; your ' +
    `operator’s remedy is then not to deliver, and the escrow refunds. ${binds} Needs the \`propose\` scope.`,
  parameters: Schema.Struct({ ...onJob, proposal: EventId, text: Text(4000) }),
  success: Schema.Struct({ job: EventId, statement: EventId, ...Signed }),
  failure: Refused,
}).annotateMerge(writing({ idempotent: true }))

const Accept = Tool.make('accept', {
  description:
    'For a request your operator posted, sign an accept of one proposal, naming its exact terms. It is a signal ' +
    'under your grant: the job’s fold counts accepts only from the buyer’s own key, so the job does not move to ' +
    '`accepted`; your operator accepts and funds from their own signer and wallet. Answers what the fold shows. ' +
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
    'On a funded job whose funded proposal you signed, publish a delivery note: the delivery’s hash (0x and 64 hex) ' +
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
)
