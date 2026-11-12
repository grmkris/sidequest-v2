import * as Domain from '@alchemy.run/domain'
import { AccountId, ListingId } from '@sidequest/protocol'
import { type DateTime, Effect, Predicate, Schema } from 'effect'
import { withScope } from '../Authority.ts'
import { NotPermitted } from '../NotPermitted.rejection.ts'
import { ListingNotPublished } from './ListingNotPublished.rejection.ts'
import { AlreadyPublished, ListingPublished, PublishListing } from './PublishListing.command.ts'
import { ListingUpdated, UpdateListing } from './UpdateListing.command.ts'
import { ListingWithdrawn, WithdrawListing } from './WithdrawListing.command.ts'

const Unpublished = Schema.TaggedStruct('Unpublished', {})
const Published = Schema.TaggedStruct('Published', { owner: AccountId })
const Withdrawn = Schema.TaggedStruct('Withdrawn', { owner: AccountId })
const ListingState = Schema.Union([Unpublished, Published, Withdrawn])
type ListingState = typeof ListingState.Type

/** The listing once it was published, withdrawn or not. */
const publishedOnce = (state: ListingState) =>
  Predicate.isTagged(state, 'Published') || Predicate.isTagged(state, 'Withdrawn') ? state : undefined

/** The listing, if the person or agent (with `propose`) sending the command acts for its owner. */
const owned = Effect.fnUntraced(function* (state: ListingState, now: DateTime.Utc) {
  const account = yield* withScope('propose', now)
  const listing = publishedOnce(state)
  if (listing === undefined) return yield* new ListingNotPublished({ state: 'Unpublished' })
  if (listing.owner !== account) return yield* new NotPermitted({ account, required: 'owner' })
  return listing
})

/** What a seller offers. Only its owner, or their agent with `propose`, changes it. */
export class Listing extends Domain.Aggregate('Listing', {
  id: ListingId,
  state: ListingState,
  initial: { _tag: 'Unpublished' },
  commands: [PublishListing, UpdateListing, WithdrawListing],
  decide: {
    PublishListing: Effect.fn(function* (state, command, { now }) {
      const owner = yield* withScope('propose', now)
      const existing = publishedOnce(state)
      if (existing !== undefined) return yield* new AlreadyPublished({ owner: existing.owner })
      const { _tag, ...details } = command
      return [new ListingPublished({ owner, ...details })]
    }),
    UpdateListing: Effect.fn(function* (state, command, { now }) {
      const listing = yield* owned(state, now)
      if (Predicate.isTagged(listing, 'Withdrawn')) return yield* new ListingNotPublished({ state: 'Withdrawn' })
      const { _tag, ...details } = command
      return [new ListingUpdated(details)]
    }),
    WithdrawListing: Effect.fn(function* (state, _, { now }) {
      const listing = yield* owned(state, now)
      return Predicate.isTagged(listing, 'Withdrawn') ? [] : [new ListingWithdrawn()]
    }),
  },
  evolve: {
    ListingPublished: (_, event) => Published.make({ owner: event.owner }),
    ListingUpdated: (state) => state,
    ListingWithdrawn: (state) =>
      Predicate.isTagged(state, 'Published') ? Withdrawn.make({ owner: state.owner }) : state,
  },
}) {}
