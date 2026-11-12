import { Schema } from 'effect'
import { AccountRef } from './AccountRef.ts'
import { Amount } from './Amount.ts'
import { AssetId } from './AssetRef.ts'
import { Bytes32 } from './Bytes32.ts'
import { JobId } from './Id.ts'
import { NetworkRef } from './NetworkRef.ts'
import { PaymentRail } from './PaymentRail.ts'

/** An escrow operation the chain reader observed, with every field it verifies before a `Record*` command. */
export const Receipt = Schema.Struct({
  job: JobId,
  rail: PaymentRail,
  network: NetworkRef,
  operation: Schema.Literals(['authorize', 'capture', 'void', 'reclaim']),
  asset: AssetId,
  amount: Amount,
  payer: AccountRef,
  payee: AccountRef,
  paymentHash: Bytes32,
  transactionHash: Bytes32,
  status: Schema.Literals(['success', 'reverted']),
  confirmations: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
})
export type Receipt = typeof Receipt.Type
