import { Schema } from 'effect'
import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api'
import { SignedIn } from './Guards.ts'
import { ListingId } from './Id.ts'
import { Listing, ListingDetails } from './Listing.ts'
import { Page, PageQuery } from './Page.ts'
import { BadCursor, refusals, NotFound } from './Refusals.ts'
import { Unavailable } from './SessionApi.ts'

const onListing = { listing: ListingId }

/** What a search matches in a listing's title or tags, letter case aside. */
export const SearchText = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(100))

/**
 * Sellers' listings: publish, update and withdraw your own; anyone reads one or searches the published ones, newest
 * first.
 */
export class ListingsApi extends HttpApiGroup.make('listings').add(
  HttpApiEndpoint.post('publish', '/api/listings', {
    payload: ListingDetails,
    success: Schema.Struct({ id: ListingId }),
    error: refusals,
  }).middleware(SignedIn),
  HttpApiEndpoint.put('update', '/api/listings/:listing', {
    params: onListing,
    payload: ListingDetails,
    error: refusals,
  }).middleware(SignedIn),
  HttpApiEndpoint.post('withdraw', '/api/listings/:listing/withdraw', {
    params: onListing,
    error: refusals,
  }).middleware(SignedIn),
  HttpApiEndpoint.get('get', '/api/listings/:listing', {
    params: onListing,
    success: Listing,
    error: [NotFound, Unavailable],
  }),
  HttpApiEndpoint.get('search', '/api/listings', {
    query: { q: Schema.optional(SearchText), ...PageQuery },
    success: Page(Listing),
    error: [BadCursor, Unavailable],
  }),
) {}
