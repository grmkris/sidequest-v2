import { format } from '@sidequest/i18n'
import {
  BadCursor,
  Conflict,
  ConflictReason,
  CrossSiteRequest,
  Forbidden,
  ForbiddenReason,
  NotFound,
  NotFoundReason,
  NotSignedIn,
  SignInRefusal,
  SignInRefused,
  Unavailable,
  Unprocessable,
  UnprocessableReason,
} from '@sidequest/protocol'
import { Effect, Option, Schema } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'
import type { Language } from './Language.ts'
import type { PlainKey } from './Text.ts'
import { NoWallet, WalletFailed, WalletRejected } from './Wallet.ts'

/** Why something a person asked for did not happen, as a value the Model keeps and the view puts into words: every
 * refusal the API declares, by its reason, and what the wallet or the network did. */
export const Problem = defineTaggedUnion({
  SignInRefused: { reason: SignInRefusal },
  NotSignedIn: {},
  Unavailable: {},
  Forbidden: { reason: ForbiddenReason },
  NotFound: { reason: NotFoundReason },
  Conflict: { reason: ConflictReason },
  Unprocessable: { reason: UnprocessableReason },
  BadCursor: {},
  CrossSite: {},
  Unreachable: {},
  NoWallet: {},
  WalletRejected: {},
  WalletFailed: { code: Schema.Option(Schema.Number) },
})
export type Problem = typeof Problem.Type

/** A Command's failure as its `Failed…` Message, carrying the problem: Commands never fail, they report. */
export const failedWith =
  <M>(toMessage: (payload: { readonly problem: Problem }) => M) =>
  (error: unknown) =>
    Effect.succeed(toMessage({ problem: problemOf(error) }))

/** The problem behind a failed request: a declared refusal by its reason, a wallet's answer, or, for anything else (no
 * network, an answer that does not decode, the client's code not loading), `Unreachable`. */
export const problemOf = (error: unknown): Problem => {
  if (error instanceof SignInRefused) {
    return Problem.SignInRefused({ reason: error.reason })
  }
  if (error instanceof Forbidden) {
    return Problem.Forbidden({ reason: error.reason })
  }
  if (error instanceof NotFound) {
    return Problem.NotFound({ reason: error.reason })
  }
  if (error instanceof Conflict) {
    return Problem.Conflict({ reason: error.reason })
  }
  if (error instanceof Unprocessable) {
    return Problem.Unprocessable({ reason: error.reason })
  }
  return plainProblemOf(error)
}

const plainProblemOf = (error: unknown): Problem => {
  if (error instanceof NotSignedIn) {
    return Problem.NotSignedIn()
  }
  if (error instanceof Unavailable) {
    return Problem.Unavailable()
  }
  if (error instanceof BadCursor) {
    return Problem.BadCursor()
  }
  if (error instanceof CrossSiteRequest) {
    return Problem.CrossSite()
  }
  return walletProblemOf(error)
}

const walletProblemOf = (error: unknown): Problem => {
  if (error instanceof NoWallet) {
    return Problem.NoWallet()
  }
  if (error instanceof WalletRejected) {
    return Problem.WalletRejected()
  }
  if (error instanceof WalletFailed) {
    return Problem.WalletFailed({ code: Option.fromNullishOr(error.code) })
  }
  return Problem.Unreachable()
}

const signInKeys: Readonly<Record<typeof SignInRefusal.Type, PlainKey>> = {
  malformed: 'problem.signIn.malformed',
  wrong_domain: 'problem.signIn.wrongDomain',
  wrong_uri: 'problem.signIn.wrongUri',
  wrong_chain: 'problem.signIn.wrongChain',
  issued_in_future: 'problem.signIn.issuedInFuture',
  stale: 'problem.signIn.stale',
  not_yet_valid: 'problem.signIn.notYetValid',
  expired: 'problem.signIn.expired',
  unknown_nonce: 'problem.signIn.unknownNonce',
  bad_signature: 'problem.signIn.badSignature',
}

const forbiddenKeys: Readonly<Record<typeof ForbiddenReason.Type, PlainKey>> = {
  NotPermitted: 'problem.forbidden.notPermitted',
  PersonRequired: 'problem.forbidden.personRequired',
  PartyRequired: 'problem.forbidden.partyRequired',
  MissingScope: 'problem.forbidden.missingScope',
  AgentRevoked: 'problem.forbidden.agentRevoked',
  GrantExpired: 'problem.forbidden.grantExpired',
  SelfBid: 'problem.forbidden.selfBid',
  AgentPaused: 'problem.forbidden.agentPaused',
}

const notFoundKeys: Readonly<Record<typeof NotFoundReason.Type, PlainKey>> = {
  NotRegistered: 'problem.notFound.notRegistered',
  ListingNotPublished: 'problem.notFound.listingNotPublished',
  NoProposal: 'problem.notFound.noProposal',
  RoomNotOpen: 'problem.notFound.roomNotOpen',
  UnknownListing: 'problem.notFound.unknownListing',
  UnknownJob: 'problem.notFound.unknownJob',
  UnknownToken: 'problem.notFound.unknownToken',
}

const conflictKeys: Readonly<Record<typeof ConflictReason.Type, PlainKey>> = {
  AlreadyRegistered: 'problem.conflict.alreadyRegistered',
  AlreadyPublished: 'problem.conflict.alreadyPublished',
  ListingNotPublished: 'problem.conflict.listingNotPublished',
  WrongState: 'problem.conflict.wrongState',
  StaleHead: 'problem.conflict.staleHead',
  SupersededVersion: 'problem.conflict.supersededVersion',
  DigestMismatch: 'problem.conflict.digestMismatch',
  AlreadyReviewed: 'problem.conflict.alreadyReviewed',
  DeliveryLate: 'problem.conflict.deliveryLate',
  NothingToSign: 'problem.conflict.nothingToSign',
  PaymentChanged: 'problem.conflict.paymentChanged',
  PaymentSubmitted: 'problem.conflict.paymentSubmitted',
  PaymentNotBegun: 'problem.conflict.paymentNotBegun',
  ChainRefused: 'problem.conflict.chainRefused',
  IdempotencyConflict: 'problem.conflict.idempotencyConflict',
  AgentTurnLimit: 'problem.conflict.agentTurnLimit',
}

const unprocessableKeys: Readonly<Record<typeof UnprocessableReason.Type, PlainKey>> = {
  ExpiryNotInFuture: 'problem.unprocessable.expiryNotInFuture',
  Unpayable: 'problem.unprocessable.unpayable',
  NotYourWallet: 'problem.unprocessable.notYourWallet',
  NoWallet: 'problem.unprocessable.noWallet',
}

/** The problem in one sentence for the person, in their language. */
export const problemText = (language: Language, problem: Problem): string =>
  Problem.match(problem, {
    SignInRefused: ({ reason }) => format(language, signInKeys[reason], {}),
    NotSignedIn: () => format(language, 'problem.notSignedIn', {}),
    Unavailable: () => format(language, 'problem.unavailable', {}),
    Forbidden: ({ reason }) => format(language, forbiddenKeys[reason], {}),
    NotFound: ({ reason }) => format(language, notFoundKeys[reason], {}),
    Conflict: ({ reason }) => format(language, conflictKeys[reason], {}),
    Unprocessable: ({ reason }) => format(language, unprocessableKeys[reason], {}),
    BadCursor: () => format(language, 'problem.badCursor', {}),
    CrossSite: () => format(language, 'problem.crossSite', {}),
    Unreachable: () => format(language, 'problem.unreachable', {}),
    NoWallet: () => format(language, 'problem.wallet.missing', {}),
    WalletRejected: () => format(language, 'problem.wallet.rejected', {}),
    WalletFailed: () => format(language, 'problem.wallet.failed', {}),
  })
