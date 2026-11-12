import { Schema } from 'effect'
import { Amount } from './Amount.ts'
import { AssetId } from './AssetRef.ts'
import { AccountId, ListingId } from './Id.ts'
import { Text } from './Text.ts'

const ListingState = Schema.Literals(['published', 'withdrawn'])

/** What a seller offers. The price is a hint; only accepted terms bind. */
export const Listing = Schema.Struct({
  id: ListingId,
  owner: AccountId,
  title: Text(200),
  description: Text(5000),
  tags: Schema.Array(Text(40)).check(Schema.isMaxLength(10), Schema.isUnique()),
  priceHint: Schema.optionalKey(Schema.Struct({ amount: Amount, asset: AssetId })),
  state: ListingState,
})
export type Listing = typeof Listing.Type
