import { Schema } from 'effect'
import { Amount } from './Amount.ts'
import { AssetId } from './AssetRef.ts'
import { AccountId, ListingId } from './Id.ts'
import { Text } from './Text.ts'

const ListingState = Schema.Literals(['published', 'withdrawn'])

/** What a seller expects to be paid, as a hint: only accepted terms bind. */
export const PriceHint = Schema.Struct({ amount: Amount, asset: AssetId })
export type PriceHint = typeof PriceHint.Type

/** What a seller writes about a listing: everything but its id, owner and state. The price is a hint. */
export const ListingDetails = Schema.Struct({
  title: Text(200),
  description: Text(5000),
  tags: Schema.Array(Text(40)).check(Schema.isMaxLength(10), Schema.isUnique()),
  priceHint: Schema.optionalKey(PriceHint),
})
export type ListingDetails = typeof ListingDetails.Type

/** What a seller offers. The price is a hint; only accepted terms bind. */
export const Listing = Schema.Struct({
  id: ListingId,
  owner: AccountId,
  ...ListingDetails.fields,
  state: ListingState,
})
export type Listing = typeof Listing.Type
