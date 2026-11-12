import { Account, AccountId } from '@sidequest/protocol'
import { Context, Effect, Layer, Schema } from 'effect'
import { RowVersion, versionedRows } from '../VersionedRows.ts'

/** The name others see for an account. `version` is the account stream's sequence number it reflects. */
export const AccountNameRow = Schema.Struct({
  id: AccountId,
  displayName: Account.fields.displayName,
  version: RowVersion,
})
export type AccountNameRow = typeof AccountNameRow.Type

/**
 * The port the `AccountNames` projection writes through. `apply` must ignore a row whose version is not newer than the
 * one it holds for that account, so redelivered names are harmless. The server implements it with D1.
 */
export class AccountNameStore extends Context.Service<
  AccountNameStore,
  {
    readonly apply: (rows: ReadonlyArray<AccountNameRow>) => Effect.Effect<void>
    readonly list: Effect.Effect<ReadonlyArray<AccountNameRow>>
  }
>()('Sidequest/AccountNameStore') {}

/** An account-name store in memory, for stories. */
export const memoryAccountNameStore = () => {
  const rows = versionedRows<AccountNameRow>()
  return AccountNameStore.of({
    apply: (changes) =>
      Effect.sync(() => {
        for (const row of changes) rows.change(row.id, row.version, () => row)
      }),
    list: Effect.sync(() => rows.all()),
  })
}

export const MemoryAccountNameStore = Layer.sync(AccountNameStore, memoryAccountNameStore)
