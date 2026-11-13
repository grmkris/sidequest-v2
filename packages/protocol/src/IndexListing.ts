import { Schema } from 'effect'
import { AccountRef } from './AccountRef.ts'
import { Hex32 } from './Hex32.ts'
import { Amount } from './Amount.ts'
import { AssetId } from './AssetRef.ts'
import { Bytes32 } from './Bytes32.ts'
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
 * How a listing is paid: `escrow`, hired through a request, a proposal and the escrow (the default), or `x402`, a
 * single paid call to a resource the seller hosts (ADR-0006). A listing's rail is not a job's: an x402 listing never
 * makes a job.
 */
export const ListingRail = Schema.Literals(['escrow', 'x402'])
export type ListingRail = typeof ListingRail.Type

/**
 * A pay-per-call listing's x402 resource as the index labels it: the URL the seller's server answers with a 402, the
 * CAIP-10 account its price is paid to, whether that account is currently the seller's verified linked wallet (a
 * label, never a filter), and how many distinct payments receipts prove on chain (`verifiedReceipts`).
 */
export const PayPerCall = Schema.Struct({
  resource: Schema.String,
  payTo: AccountRef,
  payToLinked: Schema.Boolean,
  verifiedReceipts: Schema.Int,
})
export type PayPerCall = typeof PayPerCall.Type

/**
 * A seller's listing as the index holds it: the latest NIP-99 event under the seller's key and slug (greatest
 * `createdAt`, ties to the lowest event id). `status` is the listing's own label. `network` is the CAIP-2 chain of the
 * price hint's asset, `null` without a price. `author` is what the index knows of the seller: their profile name, and
 * whether a wallet is currently linked to their key by a verified link (a label to rank by, never a filter). `rail` is
 * `x402` exactly when `payPerCall` is set.
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
  rail: ListingRail,
  payPerCall: Schema.NullOr(PayPerCall),
})
export type IndexListing = typeof IndexListing.Type

/** One listing with its description, the Markdown content of its event. */
export const IndexListingDetail = Schema.Struct({ ...IndexListing.fields, description: Schema.String })
export type IndexListingDetail = typeof IndexListingDetail.Type

/**
 * What a listing search matches: `q` in its title or summary, letter case aside; `tag` one of its topics exactly;
 * `rail` how it is paid.
 */
export const IndexListingQuery = {
  q: Schema.optional(Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(100))),
  tag: Schema.optional(IndexListingTopic),
  rail: Schema.optional(ListingRail),
  ...PageQuery,
}

/**
 * A buyer's receipt for a paid call, as the index labels it. `verified` holds only when the chain shows, at its
 * confirmation depth, a transfer of exactly `amount` (at least the listed price) of the listing's asset in
 * `transaction` from `payer` to the listing's `payTo`, and `payer` is currently linked by a verified link to the
 * receipt's author (or to the operator whose grant the author's key acted under). Anything else is unverified: a
 * receipt is a claim until the chain says so.
 */
export const ListingReceipt = Schema.Struct({
  event: Hex32,
  author: Hex32,
  createdAt: Schema.Int,
  payer: AccountRef,
  amount: Amount,
  transaction: Bytes32,
  verified: Schema.Boolean,
})
export type ListingReceipt = typeof ListingReceipt.Type

/** The most receipts the index answers for one listing, newest first. */
export const maxListingReceipts = 50
