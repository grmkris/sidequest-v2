import * as Domain from '@alchemy.run/domain'
import { Effect, Match } from 'effect'
import { Listing } from './Listing.aggregate.ts'
import { ListingStore } from './ListingStore.ts'
import { ListingPublished } from './PublishListing.command.ts'
import { ListingUpdated } from './UpdateListing.command.ts'
import { ListingWithdrawn } from './WithdrawListing.command.ts'

/** Search rows for listings: id, owner, title, tags and state, through the {@link ListingStore} port. */
export class Listings extends Domain.Projection('Listings', {
  from: [Listing],
  key: Listing,
  on: [ListingPublished, ListingUpdated, ListingWithdrawn],
}) {}

export const ListingsLive = Listings.toLayer(
  Effect.gen(function* () {
    const store = yield* ListingStore
    return (batch) =>
      store.apply(
        batch.map(({ key, event, envelope: { seq: version } }) =>
          Match.valueTags(event, {
            ListingPublished: ({ owner, title, tags }) => ({
              _tag: 'Published' as const,
              id: key.id,
              owner,
              title,
              tags,
              version,
            }),
            ListingUpdated: ({ title, tags }) => ({ _tag: 'Updated' as const, id: key.id, title, tags, version }),
            ListingWithdrawn: () => ({ _tag: 'Withdrawn' as const, id: key.id, version }),
          }),
        ),
      )
  }),
)
