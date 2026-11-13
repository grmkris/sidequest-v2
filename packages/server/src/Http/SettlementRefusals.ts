import type { ChainUnavailable } from '@sidequest/settlement/ChainRpc'
import type { UnpayableAgreement } from '@sidequest/settlement/Payment'
import type { AlreadySubmitted, NotBegun, ParametersChanged } from '@sidequest/settlement/PaymentAdapter'
import type { SettlementStoreError } from '@sidequest/settlement/ReaderCursors'
import type { CallReverted, IntentConflict } from '@sidequest/settlement/Relayer'
import { Conflict, Unavailable, Unprocessable } from '@sidequest/protocol'
import { Effect, Match } from 'effect'

/** Every way settlement refuses what the HTTP API asks of it. */
export type SettlementFailure =
  | ParametersChanged
  | AlreadySubmitted
  | NotBegun
  | UnpayableAgreement
  | CallReverted
  | IntentConflict
  | ChainUnavailable
  | SettlementStoreError

/**
 * The HTTP error for each settlement refusal: 409 when the payment's state does not allow it (another request is
 * open, it was submitted, none was begun, the chain would refuse the call), 422 for an agreement the escrow cannot
 * pay, 503 when the chain or a settlement store cannot be reached.
 */
const apiErrorOf = (failure: SettlementFailure) =>
  Match.valueTags(failure, {
    ParametersChanged: ({ request }) => new Conflict({ reason: 'PaymentChanged', evidence: { request } }),
    AlreadySubmitted: ({ request }) => new Conflict({ reason: 'PaymentSubmitted', evidence: { request } }),
    NotBegun: ({ request }) => new Conflict({ reason: 'PaymentNotBegun', evidence: { request } }),
    CallReverted: ({ function: called, reason }) =>
      new Conflict({ reason: 'ChainRefused', evidence: { function: called, reason } }),
    IntentConflict: ({ id }) => new Conflict({ reason: 'ChainRefused', evidence: { intent: id } }),
    UnpayableAgreement: ({ reason }) => new Unprocessable({ reason: 'Unpayable', evidence: { field: reason } }),
    ChainUnavailable: () => new Unavailable(),
    SettlementStoreError: () => new Unavailable(),
  })

/** A 503 says only that something was out of reach: the log says what, so a refused money call can be traced. */
const logUnavailable = (failure: SettlementFailure) =>
  Match.valueTags(failure, {
    ChainUnavailable: ({ operation, reason }) =>
      Effect.logWarning('Sidequest.Settlement.unavailable').pipe(
        Effect.annotateLogs({ alert: 'settlement-unavailable', operation, reason: reason ?? 'unknown' }),
      ),
    SettlementStoreError: ({ store }) =>
      Effect.logWarning('Sidequest.Settlement.unavailable').pipe(
        Effect.annotateLogs({ alert: 'settlement-unavailable', store }),
      ),
    ParametersChanged: () => Effect.void,
    AlreadySubmitted: () => Effect.void,
    NotBegun: () => Effect.void,
    CallReverted: () => Effect.void,
    IntentConflict: () => Effect.void,
    UnpayableAgreement: () => Effect.void,
  })

/** Answers a settlement call with the API's errors; one answered 503 is logged with what was out of reach. */
export const settlementRefused = <A, R>(call: Effect.Effect<A, SettlementFailure, R>) =>
  call.pipe(Effect.tapError(logUnavailable), Effect.mapError(apiErrorOf))
