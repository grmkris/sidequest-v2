import * as Domain from '@alchemy.run/domain'
import { Effect } from 'effect'
import { Account } from './Account.aggregate.ts'
import { AccountNameStore } from './AccountNameStore.ts'
import { AccountRegistered } from './RegisterAccount.command.ts'
import { AccountRenamed } from './RenameAccount.command.ts'

/**
 * The name others see for each account, through {@link AccountNameStore}: views name counterparts by account id, and a
 * reader looks up every name a page shows at once.
 */
export class AccountNames extends Domain.Projection('AccountNames', {
  from: [Account],
  key: Account,
  on: [AccountRegistered, AccountRenamed],
}) {}

export const AccountNamesLive = AccountNames.toLayer(
  Effect.gen(function* () {
    const store = yield* AccountNameStore
    return (batch) =>
      store.apply(
        batch.map(({ key, event, envelope: { seq: version } }) => ({
          id: key.id,
          displayName: event.displayName,
          version,
        })),
      )
  }),
)
