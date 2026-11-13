import { Schema } from 'effect'
import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api'
import { Amount } from './Amount.ts'
import { AssetId } from './AssetRef.ts'
import { Bytes32 } from './Bytes32.ts'
import { ChainOutcome, EscrowStage } from './EscrowStatus.ts'
import { NotIndexed, RateLimited, SignedEvent } from './EventsApi.ts'
import { Hex32 } from './Hex32.ts'
import { Bps } from './JobView.ts'
import { NetworkRef } from './NetworkRef.ts'
import { Unavailable, WalletAddress, WalletSignature } from './SessionApi.ts'
import { TypedData } from './TypedData.ts'
import { UnixSeconds } from './UnixSeconds.ts'

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
export const IndexFunding = Schema.Struct({
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
export type IndexFunding = typeof IndexFunding.Type

/**
 * Why the server will not relay a money call for a Nostr-native job (anyone may still send it to the chain). The
 * request or the proposal is not indexed or not valid, or the proposal names another buyer; the payment's receiver is
 * not the proposal's `payTo`; the payer's wallet has no current verified link to the request's author; the proposal
 * has expired, or its author withdrew or superseded it; the chain funded the job already, or has not funded it, or has
 * no delivery to approve or reject; the terms cannot be paid through this chain's escrow; or the chain refuses the
 * call in simulation (`detail` says why).
 */
export const IndexSettlementReason = Schema.Literals([
  'RequestNotIndexed',
  'ProposalNotIndexed',
  'ProposalForOtherBuyer',
  'ReceiverNotPayTo',
  'PayerNotLinked',
  'ProposalExpired',
  'ProposalWithdrawn',
  'ProposalSuperseded',
  'AlreadyFunded',
  'NotFunded',
  'NotDelivered',
  'Unpayable',
  'ChainRefused',
])
export type IndexSettlementReason = typeof IndexSettlementReason.Type

export class IndexSettlementRefused extends Schema.TaggedError<IndexSettlementRefused>()(
  'IndexSettlementRefused',
  { reason: IndexSettlementReason, detail: Schema.optionalKey(Schema.String) },
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
 * Where a Nostr-native job's escrow payment stands, from the chain's facts the index recorded (the job's earliest
 * funding), the chain's time (the newest confirmed block's), and the calls the relayer took on for that payment.
 * `escrow` is the escrow contract the chain's payments are held in, where a payer reclaims after expiry.
 */
export const IndexPaymentStatus = Schema.Struct({
  escrow: WalletAddress,
  paymentHash: Schema.NullOr(Bytes32),
  chainTime: UnixSeconds,
  stage: EscrowStage,
  outcome: Schema.NullOr(ChainOutcome),
  relayed: Schema.Array(RelayedCall),
})
export type IndexPaymentStatus = typeof IndexPaymentStatus.Type

/** The signed request and funded proposal behind a funded job, verbatim: the chain holds only their digest. */
export const FundedTerms = Schema.Struct({ request: SignedEvent, proposal: SignedEvent })
export type FundedTerms = typeof FundedTerms.Type

/** The transaction the relayer sent; the job follows once the chain's logs are indexed. */
const Relayed = Schema.Struct({ transactionHash: Bytes32 })
const Signed = Schema.Struct({ signature: WalletSignature })
const onJob = { id: Hex32 }
/** Unix seconds in a query string, within the contract's `uint48`. */
const SecondsFromString = Schema.FiniteFromString.check(
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
const onProposal = { id: Hex32, proposal: Hex32 }
const errors = [IndexSettlementRefused, NotIndexed, RateLimited, Unavailable]

/**
 * Escrow for Nostr-native jobs (ADR-0003): a job's id is its request event's id, its terms a signed proposal in the
 * index, its money state the chain's. Each money call carries the wallet signature of the party whose step it is, and
 * that signature is its only authority: no session, no cookie, no Nostr signature. The server checks what it can
 * before it spends gas, simulates, and relays. The ruling alone is authenticated by NIP-98, signed by the stage's
 * arbitration key; the server then signs it with the interim arbitrator's key. The group is added to `SidequestApi`
 * after `SameOrigin`, like `events`: nothing ambient is read, so a request another site makes a browser send does no
 * more than the signer could do themselves.
 */
export class IndexSettlementApi extends HttpApiGroup.make('indexSettlement').add(
  HttpApiEndpoint.get('quote', '/api/index/jobs/:id/proposals/:proposal/funding', {
    params: onProposal,
    query: Schema.Struct({ payer: WalletAddress }),
    success: IndexFunding,
    error: errors,
  }),
  HttpApiEndpoint.post('fund', '/api/index/jobs/:id/proposals/:proposal/funding', {
    params: onProposal,
    payload: Schema.Struct({ payer: WalletAddress, signature: WalletSignature }),
    success: Relayed,
    error: errors,
  }),
  HttpApiEndpoint.get('deliveryToSign', '/api/index/jobs/:id/delivery', {
    params: onJob,
    query: Schema.Struct({ deliveryHash: Bytes32 }),
    success: TypedData,
    error: errors,
  }),
  HttpApiEndpoint.post('deliver', '/api/index/jobs/:id/delivery', {
    params: onJob,
    payload: Schema.Struct({ deliveryHash: Bytes32, signature: WalletSignature }),
    success: Relayed,
    error: errors,
  }),
  HttpApiEndpoint.get('deliveryDelegationToSign', '/api/index/jobs/:id/delivery-delegation', {
    params: onJob,
    query: Schema.Struct({ delegate: WalletAddress, expiry: SecondsFromString }),
    success: TypedData,
    error: errors,
  }),
  HttpApiEndpoint.post('deliverDelegated', '/api/index/jobs/:id/delegated-delivery', {
    params: onJob,
    payload: DelegatedDelivery,
    success: Relayed,
    error: errors,
  }),
  HttpApiEndpoint.get('approvalToSign', '/api/index/jobs/:id/approval', {
    params: onJob,
    success: TypedData,
    error: errors,
  }),
  HttpApiEndpoint.post('approve', '/api/index/jobs/:id/approval', {
    params: onJob,
    payload: Signed,
    success: Relayed,
    error: errors,
  }),
  HttpApiEndpoint.get('rejectionToSign', '/api/index/jobs/:id/rejection', {
    params: onJob,
    success: TypedData,
    error: errors,
  }),
  HttpApiEndpoint.post('reject', '/api/index/jobs/:id/rejection', {
    params: onJob,
    payload: Signed,
    success: Relayed,
    error: errors,
  }),
  HttpApiEndpoint.post('rule', '/api/index/jobs/:id/ruling', {
    params: onJob,
    payload: Schema.Struct({ workerShareBps: Bps }),
    success: Relayed,
    error: [...errors, ArbitrationRefused],
  }),
  HttpApiEndpoint.get('payment', '/api/index/jobs/:id/payment', {
    params: onJob,
    success: IndexPaymentStatus,
    error: errors,
  }),
  HttpApiEndpoint.get('terms', '/api/index/jobs/:id/terms', {
    params: onJob,
    success: FundedTerms,
    error: [NotIndexed, Unavailable],
  }),
) {}
