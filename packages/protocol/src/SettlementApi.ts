import { Schema } from 'effect'
import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api'
import { Bytes32 } from './Bytes32.ts'
import { EscrowStatus } from './EscrowStatus.ts'
import { FundingRequest } from './Funding.ts'
import { SignedIn } from './Guards.ts'
import { JobId } from './Id.ts'
import { Bps, DisputeReason } from './JobView.ts'
import { refusals } from './Refusals.ts'
import { Unavailable, WalletAddress, WalletSignature } from './SessionApi.ts'
import { TypedData } from './TypedData.ts'

const onJob = { job: JobId }
const errors = [...refusals, Unavailable]

/** A signature the person made with their wallet, for the server to relay. */
const Signed = Schema.Struct({ signature: WalletSignature })

/** The transaction the server relayed. The job follows once the chain reader verified what it did. */
export const Relayed = Schema.Struct({ transactionHash: Bytes32 })

const toSign = <const Name extends string, const Path extends `/api/jobs/:job/${string}`>(name: Name, path: Path) =>
  HttpApiEndpoint.get(name, path, { params: onJob, success: TypedData, error: errors }).middleware(SignedIn)

/**
 * The hire's money, on chain. Each step is a signature from the person whose step it is, which the server only relays:
 * it holds no key of theirs. Get what to sign, sign it with the wallet, post the signature. The job's stage follows
 * from the chain, never from these requests. The buyer funds (one ERC-3009 signature over every parameter) and
 * approves or rejects; the worker records the delivery's hash; in phase 1 a configured operator account issues an
 * arbitrator's ruling with Sidequest's interim testnet key. The payment status is the chain reader's view, for either
 * party.
 */
export class SettlementApi extends HttpApiGroup.make('settlement').add(
  HttpApiEndpoint.get('funding', '/api/jobs/:job/funding', {
    params: onJob,
    query: Schema.Struct({ payer: Schema.optionalKey(WalletAddress) }),
    success: FundingRequest,
    error: errors,
  }).middleware(SignedIn),
  HttpApiEndpoint.post('fund', '/api/jobs/:job/funding', {
    params: onJob,
    payload: Signed,
    success: Relayed,
    error: errors,
  }).middleware(SignedIn),
  HttpApiEndpoint.get('payment', '/api/jobs/:job/payment', {
    params: onJob,
    success: EscrowStatus,
    error: errors,
  }).middleware(SignedIn),
  toSign('deliveryToSign', '/api/jobs/:job/delivery/signature'),
  HttpApiEndpoint.post('signDelivery', '/api/jobs/:job/delivery/signature', {
    params: onJob,
    payload: Signed,
    success: Relayed,
    error: errors,
  }).middleware(SignedIn),
  toSign('approvalToSign', '/api/jobs/:job/approval'),
  HttpApiEndpoint.post('approve', '/api/jobs/:job/approval', {
    params: onJob,
    payload: Signed,
    success: Relayed,
    error: errors,
  }).middleware(SignedIn),
  toSign('rejectionToSign', '/api/jobs/:job/rejection'),
  HttpApiEndpoint.post('reject', '/api/jobs/:job/rejection', {
    params: onJob,
    payload: Schema.Struct({ signature: WalletSignature, reason: DisputeReason }),
    success: Relayed,
    error: errors,
  }).middleware(SignedIn),
  HttpApiEndpoint.post('rule', '/api/jobs/:job/ruling', {
    params: onJob,
    payload: Schema.Struct({ workerShareBps: Bps }),
    success: Relayed,
    error: errors,
  }).middleware(SignedIn),
) {}
