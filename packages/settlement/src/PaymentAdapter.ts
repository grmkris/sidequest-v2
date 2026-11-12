import type { Agreement, FundingRequest } from '@sidequest/protocol'
import { Context, type Effect, type Option, Schema } from 'effect'
import type { Address, Hex } from 'viem'
import type { ChainUnavailable } from './ChainRpc.ts'
import type { UnpayableAgreement } from './Payment.ts'
import type { PaymentRecord } from './PaymentRequests.ts'
import type { SettlementStoreError } from './ReaderCursors.ts'
import type { RelayError, Relayed } from './Relayer.ts'

/** The id of an agreement's payment request: one per job and accepted terms, so asking again is the same request. */
export const paymentRequestId = (agreement: Agreement) => `${agreement.job}:${agreement.termsDigest}`

/** A request to pay an agreement from `payer` to `receiver`. */
export interface PaymentRequest {
  readonly id: string
  readonly agreement: Agreement
  readonly payer: Address
  readonly receiver: Address
}

/** The request id is open already with other parties; cancel it first. */
export class ParametersChanged extends Schema.TaggedError<ParametersChanged>()('ParametersChanged', {
  request: Schema.String,
}) {}

/** The request's authorization was submitted already; it can no longer change or be cancelled. */
export class AlreadySubmitted extends Schema.TaggedError<AlreadySubmitted>()('AlreadySubmitted', {
  request: Schema.String,
}) {}

/** No request was begun under this id (or it was cancelled). */
export class NotBegun extends Schema.TaggedError<NotBegun>()('NotBegun', { request: Schema.String }) {}

/**
 * How Sidequest's settlement reaches a payment rail: the escrow today, Nod's wallet later. `begin` is idempotent on
 * the request id and returns what the person must sign; it never signs for them. `submit` takes their signature and
 * hands it to the rail. `lookup` reads a request with no side effects. `cancel` withdraws a request nobody submitted
 * (a signature already given stays the signer's: the adapter only stops relaying it).
 */
export class PaymentAdapter extends Context.Service<
  PaymentAdapter,
  {
    readonly begin: (
      request: PaymentRequest,
    ) => Effect.Effect<
      FundingRequest,
      ParametersChanged | AlreadySubmitted | UnpayableAgreement | ChainUnavailable | SettlementStoreError
    >
    readonly submit: (
      id: string,
      agreement: Agreement,
      authorization: Hex,
    ) => Effect.Effect<Relayed, NotBegun | UnpayableAgreement | RelayError>
    readonly lookup: (id: string) => Effect.Effect<Option.Option<PaymentRecord>, SettlementStoreError>
    readonly cancel: (id: string) => Effect.Effect<void, AlreadySubmitted | SettlementStoreError>
  }
>()('Sidequest/Settlement/PaymentAdapter') {}
