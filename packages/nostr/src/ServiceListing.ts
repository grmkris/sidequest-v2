import { findAsset, PriceHint, Text, UnixSeconds } from '@sidequest/protocol'
import { Effect, Option, Schema } from 'effect'
import { envelopeTags, impliedTagsMatch, readEnvelope } from './Envelope.ts'
import type { EventTemplate, NostrEvent, Tag } from './Event.ts'
import { standardKinds } from './Kinds.ts'
import { type ListingAddress, listingAddressOf, ListingSlug } from './ListingAddress.ts'
import { VocabularyRefused } from './SidequestEvent.ts'
import { verifyEvent } from './Verify.ts'
import { EvmAccount, networkOfAccount } from './WalletLink.ts'

/** An x402 resource's URL: https, no credentials, no fragment, at most 2000 characters. */
export const X402ResourceUrl = Schema.String.check(
  Schema.isPattern(/^https:\/\/[^\s@#/]+(\/[^\s#]*)?$/u),
  Schema.isMaxLength(2000),
)

/**
 * What makes a listing pay-per-call (ADR-0006): the x402 resource the seller hosts, which answers 402 with an `exact`
 * offer of the listing's price, and the wallet that price is paid to, as a lowercase CAIP-10 account on the price's
 * network. Tags: `["sq-x402", <resource>]` and `["sq-pay-to", <account>]`.
 */
export const PayPerCallListing = Schema.Struct({ resource: X402ResourceUrl, payTo: EvmAccount })
export type PayPerCallListing = typeof PayPerCallListing.Type

const payPerCallPriced = (listing: {
  readonly price?: { readonly asset: string }
  readonly x402?: PayPerCallListing
}) =>
  listing.x402 === undefined ||
  (listing.price !== undefined && listing.price.asset.startsWith(`${networkOfAccount(listing.x402.payTo)}/`))

/**
 * A seller's service as a NIP-99 classified listing (kind 30402), so any NIP-99 client shows it. The price, when
 * given, is in a registered asset: NIP-99's `price` tag shows it in whole units with the asset's symbol, and
 * `["sq-price", <atomic amount>, <CAIP-19 asset>]` carries it exactly. NIP-99's `status` is `active` or `sold`. On an
 * escrow listing the price is a hint and only accepted terms bind; on a pay-per-call listing (`x402`) it is the exact
 * price of one call, so it is required, and its asset is on the network of the `payTo` account.
 */
export const ServiceListing = Schema.Struct({
  slug: ListingSlug,
  title: Text(200),
  summary: Text(500),
  description: Text(5000),
  topics: Schema.Array(Text(40).check(Schema.isLowercased())).check(Schema.isMaxLength(10), Schema.isUnique()),
  price: Schema.optionalKey(
    PriceHint.check(
      Schema.makeFilter((price) => Option.isSome(findAsset(price.asset)), { expected: 'registeredAsset' }),
    ),
  ),
  status: Schema.Literals(['active', 'sold']),
  publishedAt: UnixSeconds,
  x402: Schema.optionalKey(PayPerCallListing),
}).check(Schema.makeFilter(payPerCallPriced, { expected: 'payPerCallPricedOnItsNetwork' }))
export type ServiceListing = typeof ServiceListing.Type

/** A verified listing with its seller's address for it. */
export interface ParsedListing {
  readonly event: NostrEvent
  readonly listing: ServiceListing
  readonly address: ListingAddress
}

/** An atomic amount in whole units: `250000000` with 6 decimals is `250`, `1500000` is `1.5`. */
const wholeUnits = (amount: string, decimals: number) => {
  const digits = amount.padStart(decimals + 1, '0')
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/u, '')
  const whole = digits.slice(0, digits.length - decimals)
  return fraction === '' ? whole : `${whole}.${fraction}`
}

const priceTags = (price: ServiceListing['price']): ReadonlyArray<Tag> =>
  price === undefined
    ? []
    : Option.match(findAsset(price.asset), {
        onNone: () => [],
        onSome: (asset) => [
          ['price', wholeUnits(price.amount, asset.decimals), asset.symbol],
          ['sq-price', price.amount, price.asset],
        ],
      })

const payPerCallTags = (x402: ServiceListing['x402']): ReadonlyArray<Tag> =>
  x402 === undefined
    ? []
    : [
        ['sq-x402', x402.resource],
        ['sq-pay-to', x402.payTo],
      ]

const listingTags = (listing: ServiceListing): ReadonlyArray<Tag> => [
  ['d', listing.slug],
  ['title', listing.title],
  ['summary', listing.summary],
  ['published_at', String(listing.publishedAt)],
  ...listing.topics.map((topic) => ['t', topic]),
  ...priceTags(listing.price),
  ...payPerCallTags(listing.x402),
  ['status', listing.status],
  ...envelopeTags({ network: Option.none(), grant: Option.none() }),
]

/** The unsigned kind-30402 event for a listing: its description as Markdown content and its fields as tags. */
export const serviceListingTemplate = (listing: ServiceListing, createdAt: UnixSeconds): EventTemplate => ({
  created_at: createdAt,
  kind: standardKinds.listing,
  tags: listingTags(listing),
  content: listing.description,
})

const valueOf = (event: NostrEvent, name: string) => event.tags.find((tag) => tag[0] === name)?.[1]

const priceOf = (event: NostrEvent) => {
  const tag = event.tags.find((candidate) => candidate[0] === 'sq-price')
  return tag === undefined ? {} : { price: { amount: tag[1], asset: tag[2] } }
}

const payPerCallOf = (event: NostrEvent) => {
  const resource = valueOf(event, 'sq-x402')
  const payTo = valueOf(event, 'sq-pay-to')
  return resource === undefined && payTo === undefined ? {} : { x402: { resource, payTo } }
}

/** The listing's fields as its tags spell them, for the schema to decide. */
const fieldsOf = (event: NostrEvent) => ({
  slug: valueOf(event, 'd'),
  title: valueOf(event, 'title'),
  summary: valueOf(event, 'summary'),
  description: event.content,
  topics: event.tags.filter((tag) => tag[0] === 't').map((tag) => tag[1]),
  ...priceOf(event),
  ...payPerCallOf(event),
  status: valueOf(event, 'status'),
  publishedAt: Number(valueOf(event, 'published_at')),
})

const refused = (reason: VocabularyRefused['reason']) => new VocabularyRefused({ reason })

/**
 * Verifies a kind-30402 event and reads it as a Sidequest listing whose tags say what its fields imply: each implied tag
 * exactly, no other routing tag, and any other client's tags (`image`, `location`, …) ignored.
 */
export const parseServiceListing = Effect.fnUntraced(function* (
  input: unknown,
): Effect.fn.Return<ParsedListing, VocabularyRefused> {
  const event = yield* Effect.fromResult(verifyEvent(input)).pipe(Effect.mapError(() => refused('invalidEvent')))
  if (event.kind !== standardKinds.listing) return yield* refused('wrongKind')
  if (readEnvelope(event) === undefined) return yield* refused('badEnvelope')
  const listing = yield* Schema.decodeUnknownEffect(ServiceListing)(fieldsOf(event)).pipe(
    Effect.mapError(() => refused('badContent')),
  )
  if (!impliedTagsMatch(event.tags, listingTags(listing))) return yield* refused('tagMismatch')
  return { event, listing, address: listingAddressOf(event.pubkey, listing.slug) }
})
