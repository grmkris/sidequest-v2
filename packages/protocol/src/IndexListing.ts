import { Schema } from 'effect'
import { Hex32 } from './Hex32.ts'
import { Amount } from './Amount.ts'
import { AssetId } from './AssetRef.ts'
import { NetworkRef } from './NetworkRef.ts'
import { PageQuery } from './Page.ts'

/** What a seller expects to be paid, as a hint: only accepted terms bind. */
export const PriceHint = Schema.Struct({ amount: Amount, asset: AssetId })
export type PriceHint = typeof PriceHint.Type

/** What a search matches in a listing's title or tags, letter case aside. */
export const SearchText = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(100))

/** A listing's `d` tag: the slug its seller chose once (NIP-99, as `@sidequest/nostr` reads it). */
export const IndexListingSlug = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/u))

/** A topic as a listing's `t` tags carry it: lowercase. */
export const IndexListingTopic = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(40),
  Schema.isLowercased(),
)

/**
 * A seller's listing as the index holds it: the latest NIP-99 event under the seller's key and slug (greatest
 * `createdAt`, ties to the lowest event id). `status` is the listing's own label. `network` is the CAIP-2 chain of the
 * price hint's asset, `null` without a price. `author` is what the index knows of the seller: their profile name, and
 * whether a wallet is currently linked to their key by a verified link (a label to rank by, never a filter).
 */
export const IndexListing = Schema.Struct({
  pubkey: Hex32,
  slug: IndexListingSlug,
  event: Hex32,
  createdAt: Schema.Int,
  title: Schema.String,
  summary: Schema.String,
  topics: Schema.Array(Schema.String),
  price: Schema.NullOr(PriceHint),
  network: Schema.NullOr(NetworkRef),
  status: Schema.Literals(['active', 'sold']),
  publishedAt: Schema.Int,
  author: Schema.Struct({ name: Schema.NullOr(Schema.String), walletVerified: Schema.Boolean }),
})
export type IndexListing = typeof IndexListing.Type

/** One listing with its description, the Markdown content of its event. */
export const IndexListingDetail = Schema.Struct({ ...IndexListing.fields, description: Schema.String })
export type IndexListingDetail = typeof IndexListingDetail.Type

/** What a listing search matches: `q` in its title or summary, letter case aside; `tag` one of its topics exactly. */
export const IndexListingQuery = {
  q: Schema.optional(Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(100))),
  tag: Schema.optional(IndexListingTopic),
  ...PageQuery,
}
