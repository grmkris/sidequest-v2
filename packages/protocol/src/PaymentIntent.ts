import { Schema } from 'effect'
import { AccountRef } from './AccountRef.ts'
import { Amount } from './Amount.ts'
import { AssetId } from './AssetRef.ts'
import { Digest } from './Digest.ts'
import { JobId } from './Id.ts'
import { NetworkRef } from './NetworkRef.ts'
import { PaymentRail } from './PaymentRail.ts'

/** The payment an agreement asks the buyer to make, before anything is on chain. */
export const PaymentIntent = Schema.Struct({
  job: JobId,
  rail: PaymentRail,
  network: NetworkRef,
  asset: AssetId,
  amount: Amount,
  payer: AccountRef,
  payee: AccountRef,
  termsDigest: Digest,
})
export type PaymentIntent = typeof PaymentIntent.Type
