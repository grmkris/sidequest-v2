import { AccountId, AccountName, type Unavailable } from '@sidequest/protocol'
import { Context, Effect, Layer, Option, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'
import { stored } from '../SignIn/Stored.ts'

/**
 * Reading the names accounts go by from the `account_names` projection: every name a page shows in one statement,
 * however many rows name them, and an account with no name recorded yet left out. D1 not answering is `Unavailable`.
 */
export class AccountNameReads extends Context.Service<
  AccountNameReads,
  {
    readonly names: (ids: ReadonlyArray<AccountId>) => Effect.Effect<ReadonlyArray<AccountName>, Unavailable>
    readonly name: (id: AccountId) => Effect.Effect<Option.Option<AccountName['displayName']>, Unavailable>
  }
>()('Sidequest/AccountNameReads') {
  static readonly layer = Layer.effect(
    AccountNameReads,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const named = SqlSchema.findAll({
        Request: Schema.Array(AccountId),
        Result: AccountName,
        execute: (ids) => sql`
          SELECT id AS account, display_name AS displayName FROM account_names
          WHERE id IN (SELECT value FROM json_each(${JSON.stringify(ids)})) ORDER BY id`,
      })
      const names = Effect.fn('Sidequest.AccountNameReads.names')(function* (ids: ReadonlyArray<AccountId>) {
        return ids.length === 0 ? [] : yield* stored(named(ids))
      })
      return AccountNameReads.of({
        names,
        name: Effect.fn('Sidequest.AccountNameReads.name')(function* (id) {
          const [found] = yield* names([id])
          return Option.map(Option.fromUndefinedOr(found), ({ displayName }) => displayName)
        }),
      })
    }),
  )
}
