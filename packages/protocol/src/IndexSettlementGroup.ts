import { Schema } from 'effect'
import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api'
import { Bytes32 } from './Bytes32.ts'
import { NotIndexed } from './EventsApi.ts'
import { Bps } from './JobView.ts'
import { Unavailable, WalletAddress, WalletSignature } from './SessionApi.ts'
import { TypedData } from './TypedData.ts'
import {
  ArbitrationRefused,
  DelegatedDelivery,
  FundedTerms,
  IndexFunding,
  IndexPaymentStatus,
  Relayed,
  SecondsFromString,
  Signed,
  errors,
  onJob,
  onProposal,
} from './IndexSettlementApi.ts'

// The `IndexSettlementApi` group alone, apart from its schemas and errors in `IndexSettlementApi.ts`: a group is a class built by calls,
// which a bundler keeps wherever its module is imported, so a page that needs only the schemas never loads it.

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
