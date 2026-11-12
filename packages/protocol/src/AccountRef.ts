import { Schema } from 'effect'
import { networkPattern } from './NetworkRef.ts'

/** A CAIP-10 account id: `<CAIP-2 chain id>:<address>`, e.g. a wallet on Arc testnet. */
export const AccountRef = Schema.String.check(
  Schema.isPattern(new RegExp(`^${networkPattern}:[-.%a-zA-Z0-9]{1,128}$`)),
).pipe(Schema.brand('AccountRef'))
export type AccountRef = typeof AccountRef.Type
