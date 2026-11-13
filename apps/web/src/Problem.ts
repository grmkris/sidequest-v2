import { format } from '@sidequest/i18n'
import { BadCursor, Unavailable } from '@sidequest/protocol'
import { Effect, Option, Schema } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'
import type { Language } from './Language.ts'
import { NoWallet, WalletFailed, WalletRejected } from './Wallet.ts'

/** Why something a person asked for did not happen, as a value the Model keeps and the view puts into words: the API's
 * general refusals, and what the wallet or the network did. The index's and the escrow's own refusals are read where
 * they are asked for. */
export const Problem = defineTaggedUnion({
  Unavailable: {},
  BadCursor: {},
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

/** The problem behind a failed request: a general refusal, a wallet's answer, or, for anything else (no network, an
 * answer that does not decode, the client's code not loading), `Unreachable`. */
export const problemOf = (error: unknown): Problem => {
  if (error instanceof Unavailable) {
    return Problem.Unavailable()
  }
  if (error instanceof BadCursor) {
    return Problem.BadCursor()
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

/** The problem in one sentence for the person, in their language. */
export const problemText = (language: Language, problem: Problem): string =>
  Problem.match(problem, {
    Unavailable: () => format(language, 'problem.unavailable', {}),
    BadCursor: () => format(language, 'problem.badCursor', {}),
    Unreachable: () => format(language, 'problem.unreachable', {}),
    NoWallet: () => format(language, 'problem.wallet.missing', {}),
    WalletRejected: () => format(language, 'problem.wallet.rejected', {}),
    WalletFailed: () => format(language, 'problem.wallet.failed', {}),
  })
