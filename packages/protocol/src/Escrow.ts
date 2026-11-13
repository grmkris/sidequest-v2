import { Schema } from 'effect'
import { Amount } from './Amount.ts'
import { AssetId } from './AssetRef.ts'
import { Bytes32 } from './Bytes32.ts'
import { NotIndexed, RateLimited, SignedEvent } from './EventsApi.ts'
import { Hex32 } from './Hex32.ts'
import { NetworkRef } from './NetworkRef.ts'
import { Unavailable } from './Refusals.ts'
import { TypedData } from './TypedData.ts'
import { UnixSeconds } from './UnixSeconds.ts'
import { WalletAddress, WalletSignature } from './Wallet.ts'

/** A share in basis points: 0 is none, 10 000 is all. */
export const Bps = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 }))

/** How `SidequestOperator` settled a job: its `Outcome`, plus the escrow's own `reclaim` by the payer. */
export const ChainOutcome = Schema.Literals([
  'Approved',
  'AcceptedBySilence',
  'Ruled',
  'Unruled',
  'Undelivered',
  'Reclaimed',
])
export type ChainOutcome = typeof ChainOutcome.Type

/** Where the job's escrow payment is on chain, counting only events at the required confirmation depth. */
export const EscrowStage = Schema.Literals(['Unfunded', 'Funded', 'Delivered', 'Disputed', 'Settled'])
export type EscrowStage = typeof EscrowStage.Type

/** An integer of up to 256 bits as a decimal string, as the chain's words outgrow JavaScript numbers. */
const Word = Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]{0,77})$/u))
const Seconds = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 ** 48 - 1 }))

/** `AuthCaptureEscrow.PaymentInfo`, as the protocol carries it: integers as decimal strings or safe integers. */
export const EscrowPaymentInfo = Schema.Struct({
  operator: WalletAddress,
  payer: WalletAddress,
  receiver: WalletAddress,
  token: WalletAddress,
  maxAmount: Amount,
  preApprovalExpiry: Seconds,
  authorizationExpiry: Seconds,
  refundExpiry: Seconds,
  minFeeBps: Bps,
  maxFeeBps: Bps,
  feeReceiver: WalletAddress,
  salt: Word,
})
export type EscrowPaymentInfo = typeof EscrowPaymentInfo.Type

/** `SidequestOperator.JobParams`: `jobId` is the request event's id, `termsDigest` the proposal's, both as words. */
export const EscrowJobParams = Schema.Struct({
  jobId: Bytes32,
  termsDigest: Bytes32,
  deliveryDeadline: Seconds,
  reviewWindow: Seconds,
  disputeWindow: Seconds,
  arbitrationWindow: Seconds,
  arbitrator: WalletAddress,
})
export type EscrowJobParams = typeof EscrowJobParams.Type

/**
 * What the buyer's wallet signs to fund proposal `proposal` of job `job` from `payer`: the escrow payment built from
 * the proposal's signed terms and `payTo`, its job parameters, and the ERC-3009 `ReceiveWithAuthorization` whose nonce
 * is the payment's hash without the payer, so the one signature commits to every field shown.
 */
export const EscrowFunding = Schema.Struct({
  job: Hex32,
  proposal: Hex32,
  paymentHash: Bytes32,
  network: NetworkRef,
  asset: AssetId,
  amount: Amount,
  paymentInfo: EscrowPaymentInfo,
  jobParams: EscrowJobParams,
  escrow: WalletAddress,
  typedData: TypedData,
})
export type EscrowFunding = typeof EscrowFunding.Type

/**
 * Why the server will not relay a money call for a job (anyone may still send it to the chain). The
 * request or the proposal is not indexed or not valid, or the proposal names another buyer; the payment's receiver is
 * not the proposal's `payTo`; the payer's wallet has no current verified link to the request's author; the proposal
 * has expired, or its author withdrew or superseded it, or an agent signed it under a grant that does not authorise it; the chain funded the job already, or has not funded it, or has
 * no delivery to approve or reject; the terms cannot be paid through this chain's escrow; the stage's launch caps
 * refuse it (`LaunchCap`, `detail` says which: `MaxJobAmount`, `PartyNotAllowed` or `DailyGasBudget`); or the chain
 * refuses the call in simulation (`detail` says why).
 */
export const EscrowRefusalReason = Schema.Literals([
  'RequestNotIndexed',
  'ProposalNotIndexed',
  'ProposalForOtherBuyer',
  'ReceiverNotPayTo',
  'PayerNotLinked',
  'ProposalExpired',
  'ProposalWithdrawn',
  'ProposalSuperseded',
  'ProposalNotAuthorised',
  'AlreadyFunded',
  'NotFunded',
  'NotDelivered',
  'Unpayable',
  'LaunchCap',
  'ChainRefused',
])
export type EscrowRefusalReason = typeof EscrowRefusalReason.Type

export class EscrowRefused extends Schema.TaggedError<EscrowRefused>()(
  'EscrowRefused',
  { reason: EscrowRefusalReason, detail: Schema.optionalKey(Schema.String) },
  { httpApiStatus: 409 },
) {}

/** A ruling's NIP-98 authorization is missing, does not verify for this request, or is not the arbitration key's. */
export class ArbitrationRefused extends Schema.TaggedError<ArbitrationRefused>()(
  'ArbitrationRefused',
  { reason: Schema.String },
  { httpApiStatus: 401 },
) {}

/** One call the relayer took on for a payment: its intent, how far it went, and the transaction that used its nonce. */
export const RelayedCall = Schema.Struct({
  intent: Schema.String,
  state: Schema.Literals(['open', 'mined', 'released']),
  transactionHash: Schema.NullOr(Bytes32),
  reason: Schema.NullOr(Schema.String),
})
export type RelayedCall = typeof RelayedCall.Type

/**
 * Where a job's escrow payment stands, from the chain's facts the index recorded (the job's earliest
 * funding), the chain's time (the newest confirmed block's), and the calls the relayer took on for that payment.
 * `escrow` is the escrow contract the chain's payments are held in, where a payer reclaims after expiry; `operator` is
 * the `SidequestOperator` this stage funds and settles through, which a client can check before it signs.
 */
export const EscrowPaymentStatus = Schema.Struct({
  escrow: WalletAddress,
  operator: WalletAddress,
  paymentHash: Schema.NullOr(Bytes32),
  chainTime: UnixSeconds,
  stage: EscrowStage,
  outcome: Schema.NullOr(ChainOutcome),
  relayed: Schema.Array(RelayedCall),
})
export type EscrowPaymentStatus = typeof EscrowPaymentStatus.Type

/** The signed request and funded proposal behind a funded job, verbatim: the chain holds only their digest. */
export const FundedTerms = Schema.Struct({ request: SignedEvent, proposal: SignedEvent })
export type FundedTerms = typeof FundedTerms.Type

/** The transaction the relayer sent; the job follows once the chain's logs are indexed. */
export const Relayed = Schema.Struct({ transactionHash: Bytes32 })
export const Signed = Schema.Struct({ signature: WalletSignature })
export const onJob = { id: Hex32 }
/** Unix seconds in a query string, within the contract's `uint48`. */
export const SecondsFromString = Schema.FiniteFromString.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: 2 ** 48 - 1 }),
)

/**
 * A delivery recorded under the worker's delegation (`SidequestOperator.deliverDelegated`): the artefact's hash, the
 * delegate's EIP-712 `Delivery` signature (an EOA key, for an agent its Nostr key's EVM key), and the worker wallet's
 * `DeliveryDelegate` signature naming that delegate and `expiry`, which bounds it.
 */
export const DelegatedDelivery = Schema.Struct({
  deliveryHash: Bytes32,
  delegate: WalletAddress,
  expiry: Seconds,
  signature: WalletSignature,
  delegation: WalletSignature,
})
export type DelegatedDelivery = typeof DelegatedDelivery.Type
export const onProposal = { id: Hex32, proposal: Hex32 }
export const errors = [EscrowRefused, NotIndexed, RateLimited, Unavailable]
