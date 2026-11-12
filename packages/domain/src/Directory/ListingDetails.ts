import { Listing } from '@sidequest/protocol'

/** What a seller writes about a listing: everything but its id, owner and state. */
export const ListingDetails = {
  title: Listing.fields.title,
  description: Listing.fields.description,
  tags: Listing.fields.tags,
  priceHint: Listing.fields.priceHint,
}
