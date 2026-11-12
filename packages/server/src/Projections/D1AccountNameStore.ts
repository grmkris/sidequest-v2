import { AccountNameRow, AccountNameStore } from '@sidequest/domain/Identity/AccountNameStore'
import { Effect, Layer, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

/**
 * The `account_names` table behind the `AccountNames` projection: one row per account, written only when the version
 * is newer than the row's, so a redelivered name does nothing. D1 failing is a defect: the projection's delivery is
 * retried.
 */
export const D1AccountNameStore = Layer.effect(
  AccountNameStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const write = ({ id, displayName, version }: AccountNameRow) => sql`
      INSERT INTO account_names (id, display_name, version) VALUES (${id}, ${displayName}, ${version})
      ON CONFLICT (id) DO UPDATE SET display_name = excluded.display_name, version = excluded.version
      WHERE excluded.version > account_names.version`
    const list = SqlSchema.findAll({
      Request: Schema.Void,
      Result: AccountNameRow,
      execute: () => sql`SELECT id, display_name AS displayName, version FROM account_names ORDER BY id`,
    })
    return AccountNameStore.of({
      apply: Effect.fn('Sidequest.AccountNames.apply')(function* (rows) {
        yield* Effect.forEach(rows, write, { discard: true }).pipe(Effect.orDie)
      }),
      list: list(undefined).pipe(Effect.orDie, Effect.withSpan('Sidequest.AccountNames.list')),
    })
  }),
)
