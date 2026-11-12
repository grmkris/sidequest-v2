import { Option, Schema } from 'effect'
import { Amount } from './Amount.ts'
import { AssetId } from './AssetRef.ts'
import { findAsset } from './AssetRegistry.ts'
import { NetworkRef } from './NetworkRef.ts'
import { PaymentRail } from './PaymentRail.ts'
import { Text } from './Text.ts'
import { UnixSeconds } from './UnixSeconds.ts'

const hour = 60 * 60
const day = 24 * hour

const windowSeconds = (minimum: number, maximum: number) => Schema.Int.check(Schema.isBetween({ minimum, maximum }))

/**
 * What a proposal offers and an agreement binds. The windows follow the escrow operator: review
 * and dispute last 1 hour to 14 days, arbitration 12 hours to 14 days.
 */
export const Terms = Schema.Struct({
  title: Text(200),
  deliverables: Schema.Array(Text(2000)).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
  amount: Amount.check(Schema.makeFilter((amount: string) => amount !== '0', { expected: 'positiveAmount' })),
  asset: AssetId,
  network: NetworkRef,
  deliveryDeadline: UnixSeconds,
  reviewWindowSeconds: windowSeconds(hour, 14 * day),
  disputeWindowSeconds: windowSeconds(hour, 14 * day),
  arbitrationWindowSeconds: windowSeconds(12 * hour, 14 * day),
  rail: PaymentRail,
}).check(
  Schema.makeFilter((terms) => Option.exists(findAsset(terms.asset), (asset) => asset.network === terms.network), {
    expected: 'registeredAssetOnTermsNetwork',
  }),
)
export type Terms = typeof Terms.Type
