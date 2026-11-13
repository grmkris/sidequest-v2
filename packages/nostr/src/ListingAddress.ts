import { Schema } from 'effect'
import type { PublicKey } from './Keys.ts'

/** A listing's `d` tag: a stable slug its seller chooses once, so retitling a listing never forks it. */
export const ListingSlug = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/u)).pipe(
  Schema.brand('ListingSlug'),
)
export type ListingSlug = typeof ListingSlug.Type

/** A NIP-01 address of a NIP-99 listing, `30402:<seller public key>:<slug>`: the listing whatever its version. */
export const ListingAddress = Schema.String.check(
  Schema.isPattern(/^30402:[0-9a-f]{64}:[a-z0-9][a-z0-9-]{0,63}$/u),
).pipe(Schema.brand('ListingAddress'))
export type ListingAddress = typeof ListingAddress.Type

/** The address of a seller's listing. */
export const listingAddressOf = (seller: PublicKey, slug: ListingSlug): ListingAddress =>
  // A public key is 64 lowercase hex characters and a slug matches the address's last part.
  ListingAddress.make(`30402:${seller}:${slug}`)
