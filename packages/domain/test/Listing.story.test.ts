import { Story } from '@alchemy.run/domain/Story'
import { ListingId } from '@sidequest/protocol'
import { describe, it } from '@effect/vitest'
import { CurrentActor } from '../src/CurrentActor.context.ts'
import { Listing } from '../src/Directory/Listing.aggregate.ts'
import { ListingNotPublished } from '../src/Directory/ListingNotPublished.rejection.ts'
import { AlreadyPublished, ListingPublished, PublishListing } from '../src/Directory/PublishListing.command.ts'
import { ListingUpdated, UpdateListing } from '../src/Directory/UpdateListing.command.ts'
import { ListingWithdrawn, WithdrawListing } from '../src/Directory/WithdrawListing.command.ts'
import { MissingScope } from '../src/MissingScope.rejection.ts'
import { NotPermitted } from '../src/NotPermitted.rejection.ts'
import { agentOf, bob, bobAgent, carol, person, story } from './fixtures.ts'

const listing = Listing.ref(ListingId.make('listing_01JCXZ4Q6N8M2V7T3R5W9Y0B1D'))
const details = { title: 'Hand-drawn logos', description: 'Three concepts, two rounds.', tags: ['logo', 'branding'] }
const updated = { ...details, tags: ['logo'] }

describe('a listing', () => {
  it.effect('is published by a seller’s agent with propose, then updated and withdrawn by its owner', () =>
    story(
      Story.provide(CurrentActor, agentOf(bob, bobAgent, ['propose'])),
      Story.when(listing, new PublishListing(details)),
      Story.then(listing, new ListingPublished({ owner: bob, ...details })),
      Story.provide(CurrentActor, person(bob)),
      Story.when(listing, new UpdateListing(updated)),
      Story.then(listing, new ListingUpdated(updated)),
      Story.when(listing, new WithdrawListing()),
      Story.then(listing, new ListingWithdrawn()),
      Story.when(listing, new WithdrawListing()),
      Story.then(listing),
      Story.when(listing, new UpdateListing(details)),
      Story.rejected(new ListingNotPublished({ state: 'Withdrawn' })),
    ),
  )

  it.effect('refuses changes before publishing, a second publish, and anyone but its owner', () =>
    story(
      Story.provide(CurrentActor, person(bob)),
      Story.when(listing, new WithdrawListing()),
      Story.rejected(new ListingNotPublished({ state: 'Unpublished' })),
      Story.provide(CurrentActor, agentOf(bob, bobAgent, ['discuss'])),
      Story.when(listing, new PublishListing(details)),
      Story.rejected(new MissingScope({ agent: bobAgent, scope: 'propose' })),
      Story.provide(CurrentActor, person(bob)),
      Story.when(listing, new PublishListing(details)),
      Story.then(listing, new ListingPublished({ owner: bob, ...details })),
      Story.provide(CurrentActor, person(carol)),
      Story.when(listing, new PublishListing(details)),
      Story.rejected(new AlreadyPublished({ owner: bob })),
      Story.when(listing, new WithdrawListing()),
      Story.rejected(new NotPermitted({ account: carol, required: 'owner' })),
    ),
  )
})
