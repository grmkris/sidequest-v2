import { Schema } from 'effect'
import { NetworkRef, networkPattern } from './NetworkRef.ts'
import { Text } from './Text.ts'

/** A CAIP-19 asset id: `<CAIP-2 chain id>/<namespace>:<reference>`, with an optional `/<token id>`. */
export const AssetId = Schema.String.check(
  Schema.isPattern(new RegExp(`^${networkPattern}/[-a-z0-9]{3,8}:[-.%a-zA-Z0-9]{1,128}(/[-.%a-zA-Z0-9]{1,78})?$`)),
).pipe(Schema.brand('AssetId'))
export type AssetId = typeof AssetId.Type

/** A registered asset. Amounts of it are integers in units of 10^-decimals. */
export const AssetRef = Schema.Struct({
  id: AssetId,
  network: NetworkRef,
  decimals: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 77 })),
  symbol: Text(16),
}).check(
  Schema.makeFilter((asset) => asset.id.startsWith(`${asset.network}/`), {
    expected: 'assetIdOnAssetNetwork',
  }),
)
export type AssetRef = typeof AssetRef.Type
