import { format } from '@sidequest/i18n'
import { AccountId, AccountName, maxNamesPerLookup } from '@sidequest/protocol'
import { Array, Effect, Option, Schema } from 'effect'
import { Command } from 'foldkit'
import { SidequestClient } from './Api.ts'
import type { Language } from './Language.ts'
import { failedWith, type Problem } from './Problem.ts'
import { shortId } from './Text.ts'

// The names accounts go by. Views name counterparts by account id; a page looks up every name it shows at once, and
// shows an account's short id until its name is known.

/** The names a page knows, as the API answered them. */
export const Names = Schema.Array(AccountName)
export type Names = typeof Names.Type

/** The name `account` goes by, or its short id while the name is not known. */
export const nameOf = (names: Names, account: AccountId, language: Language): string =>
  Option.match(
    Array.findFirst(names, (named) => named.account === account),
    {
      onNone: () => format(language, 'common.account', { id: shortId(account) }),
      onSome: (named) => named.displayName,
    },
  )

/** The accounts among `ids` whose names are neither known nor asked for already, each once, as one lookup takes them. */
export const unnamed = (
  ids: ReadonlyArray<AccountId>,
  names: Names,
  asked: ReadonlyArray<AccountId>,
): ReadonlyArray<AccountId> =>
  Array.take(
    Array.filter(Array.dedupe(ids), (id) => !asked.includes(id) && !Array.some(names, (named) => named.account === id)),
    maxNamesPerLookup,
  )

/** A page's `SucceededReadNames` Message: the names its lookup found. */
type NamesMessage<S> = Schema.Top & ((payload: { readonly names: Names }) => Schema.Schema.Type<S>)

/** A page's `FailedReadNames` Message: why its lookup failed. */
type NamesProblemMessage<F> = Schema.Top & ((payload: { readonly problem: Problem }) => Schema.Schema.Type<F>)

/** A page's `ReadNames` Command: look up the names of some accounts in one request, answering with the page's own
 * Messages. */
export const defineReadNames = <S extends NamesMessage<S>, F extends NamesProblemMessage<F>>(
  succeeded: S,
  failed: F,
) => {
  const ReadNames = Command.define('ReadNames', {
    args: { ids: Schema.NonEmptyArray(AccountId) },
    messages: [succeeded, failed],
    execute: ({ ids }) =>
      Effect.gen(function* () {
        const api = yield* (yield* SidequestClient).api
        const { names } = yield* api.account.names({ query: { ids } })
        return succeeded({ names })
      }).pipe(Effect.catch(failedWith(failed))),
  })
  return ReadNames
}

/** Names learned now added to the ones known. */
export const withNames = (known: Names, learned: Names): Names =>
  Array.appendAll(
    Array.filter(known, (named) => !Array.some(learned, (fresh) => fresh.account === named.account)),
    learned,
  )
