import { Schema } from 'effect'
import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api'
import { AccountRef } from './AccountRef.ts'
import { Hex32 } from './Hex32.ts'
import {
  IndexListing,
  IndexListingDetail,
  IndexListingQuery,
  IndexListingSlug,
  ListingReceipt,
} from './IndexListing.ts'
import { Page } from './Page.ts'
import { BadCursor, Unavailable } from './Refusals.ts'
import {
  EventInvalid,
  EventTooLarge,
  KeyJob,
  KindNotIndexed,
  LinkedWallet,
  NotIndexed,
  Person,
  PersonName,
  Pubkeys,
  Published,
  RateLimited,
  SignedEvent,
} from './EventsApi.ts'

// The `EventsApi` group alone, apart from its schemas and errors in `EventsApi.ts`: a group is a class built by calls,
// which a bundler keeps wherever its module is imported, so a page that needs only the schemas never loads it.

/**
 * The index over signed Nostr events. Anyone publishes one signed event through it (the event authenticates itself,
 * so there is no session) and the index stores it and relays it on; anyone reads a stored event, what the index knows
 * of a key, the names of up to `maxPeoplePerLookup` keys at once (one answer for each key asked for), which
 * key a wallet is linked to, the jobs a key wrote a request or a proposal for (newest first, at most
 * `maxKeyJobs`: what a client computes its inbox from), sellers' NIP-99 listings (searched newest first, or
 * one by its seller and slug), and the payment receipts of a pay-per-call listing, each labelled verified or not
 * (newest first, at most `maxListingReceipts`). Publishing is limited per client and per key.
 */
export class EventsApi extends HttpApiGroup.make('events').add(
  HttpApiEndpoint.post('publish', '/api/events', {
    payload: SignedEvent,
    success: Published,
    error: [EventInvalid, KindNotIndexed, EventTooLarge, RateLimited, Unavailable],
  }),
  HttpApiEndpoint.get('event', '/api/events/:id', {
    params: { id: Hex32 },
    success: SignedEvent,
    error: [NotIndexed, Unavailable],
  }),
  HttpApiEndpoint.get('person', '/api/people/:pubkey', {
    params: { pubkey: Hex32 },
    success: Person,
    error: [NotIndexed, Unavailable],
  }),
  HttpApiEndpoint.get('personJobs', '/api/people/:pubkey/jobs', {
    params: { pubkey: Hex32 },
    success: Schema.Struct({ items: Schema.Array(KeyJob) }),
    error: Unavailable,
  }),
  HttpApiEndpoint.get('people', '/api/people', {
    query: { pubkeys: Pubkeys },
    success: Schema.Struct({ people: Schema.Array(PersonName) }),
    error: Unavailable,
  }),
  HttpApiEndpoint.get('wallet', '/api/wallets/:account', {
    params: { account: AccountRef },
    success: LinkedWallet,
    error: [NotIndexed, Unavailable],
  }),
  HttpApiEndpoint.get('listings', '/api/index/listings', {
    query: IndexListingQuery,
    success: Page(IndexListing),
    error: [BadCursor, Unavailable],
  }),
  HttpApiEndpoint.get('listing', '/api/index/listings/:pubkey/:slug', {
    params: { pubkey: Hex32, slug: IndexListingSlug },
    success: IndexListingDetail,
    error: [NotIndexed, Unavailable],
  }),
  HttpApiEndpoint.get('listingReceipts', '/api/index/listings/:pubkey/:slug/receipts', {
    params: { pubkey: Hex32, slug: IndexListingSlug },
    success: Schema.Struct({ items: Schema.Array(ListingReceipt) }),
    error: Unavailable,
  }),
) {}
