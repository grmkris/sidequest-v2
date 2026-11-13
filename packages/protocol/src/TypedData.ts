import { Schema } from 'effect'
import { WalletAddress } from './Wallet.ts'

const TypedDataField = Schema.Struct({ name: Schema.String, type: Schema.String })

/**
 * EIP-712 typed data for a wallet to sign (`eth_signTypedData_v4`), as JSON: integers are decimal strings, so no value
 * loses precision on the way to the browser. The server builds it; the person's wallet shows and signs it.
 */
export const TypedData = Schema.Struct({
  domain: Schema.Struct({
    name: Schema.String,
    version: Schema.String,
    chainId: Schema.Int,
    verifyingContract: WalletAddress,
  }),
  types: Schema.Record(Schema.String, Schema.Array(TypedDataField)),
  primaryType: Schema.String,
  message: Schema.Record(Schema.String, Schema.String),
})
export type TypedData = typeof TypedData.Type
