import { Schema } from 'effect'
import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api'
import { SignedIn } from './Guards.ts'
import { ListingId } from './Id.ts'
import { Listing, ListingDetails } from './Listing.ts'
import { Page, PageQuery } from './Page.ts'
import { BadCursor, refusals, NotFound } from './Refusals.ts'
import { Unavailable } from './SessionApi.ts'
import { SearchText, onListing } from './ListingsApi.ts'

// The `ListingsApi` group alone, apart from its schemas and errors in `ListingsApi.ts`: a group is a class built by calls,
// which a bundler keeps wherever its module is imported, so a page that needs only the schemas never loads it.

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
