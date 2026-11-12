import { Schema } from 'effect'
import { AccountRef } from './AccountRef.ts'
import { Amount } from './Amount.ts'
import { AssetId } from './AssetRef.ts'
import { JobId } from './Id.ts'
import { NetworkRef } from './NetworkRef.ts'
import { PaymentRail } from './PaymentRail.ts'

const Bytes32 = Schema.String.check(Schema.isPattern(/^0x[0-9a-f]{64}$/))

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
