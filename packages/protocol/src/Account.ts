import { Schema } from 'effect'
import { AccountRef } from './AccountRef.ts'
import { AccountId } from './Id.ts'
import { Text } from './Text.ts'

export const Account = Schema.Struct({
  id: AccountId,
  displayName: Text(80),
  wallets: Schema.Array(AccountRef).check(Schema.isUnique()),
})
export type Account = typeof Account.Type
