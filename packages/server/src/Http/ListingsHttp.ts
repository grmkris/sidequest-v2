import { generateId, NotFound, SidequestApi } from '@sidequest/protocol'
import { Effect, Option } from 'effect'
import { HttpApiBuilder } from 'effect/http-api'
import { ListingReads } from '../Reads/ListingReads.ts'
import { PeopleClients, signedIn } from './People.ts'

/** The `listings` group: sellers change their own listings through the model; anyone reads them from D1. */
export const listingsHandlers = HttpApiBuilder.group(SidequestApi, 'listings', (handlers) =>
  Effect.gen(function* () {
    const listings = yield* ListingReads
    const asPerson = signedIn(yield* PeopleClients)
    return handlers
      .handle('publish', ({ payload }) =>
        Effect.gen(function* () {
          const id = yield* generateId('ListingId')
          yield* asPerson.ask((people) => people.PublishListing({ target: id, ...payload }))
          return { id }
        }),
      )
      .handle('update', ({ params, payload }) =>
        asPerson.send((people) => people.UpdateListing({ target: params.listing, ...payload })),
      )
      .handle('withdraw', ({ params }) => asPerson.send((people) => people.WithdrawListing({ target: params.listing })))
      .handle('get', ({ params }) =>
        Effect.flatMap(
          listings.find(params.listing),
          Option.match({
            onNone: () =>
              Effect.fail(new NotFound({ reason: 'UnknownListing', evidence: { listing: params.listing } })),
            onSome: Effect.succeed,
          }),
        ),
      )
      .handle('search', ({ query: { q, limit, cursor } }) => listings.search({ text: q, limit, cursor }))
  }),
)
