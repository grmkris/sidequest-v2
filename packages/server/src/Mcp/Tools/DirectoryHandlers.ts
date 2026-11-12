import { DirectoryTools, generateId, NotFound } from '@sidequest/protocol'
import { Effect, Option } from 'effect'
import { PeopleClients } from '../../Http/People.ts'
import { ListingReads } from '../../Reads/ListingReads.ts'
import { currentCaller } from '../McpCaller.ts'
import { asAgent } from './AsAgent.ts'

/** `find`, `get_listing` and `publish_listing`: the listings HTTP serves, read from D1, published through the model. */
export const DirectoryHandlers = DirectoryTools.toLayer(
  Effect.gen(function* () {
    const listings = yield* ListingReads
    const clients = yield* PeopleClients
    return DirectoryTools.of({
      find: ({ text, limit, cursor }) => listings.search({ text, limit, cursor }),
      get_listing: ({ listing }) =>
        Effect.flatMap(
          listings.find(listing),
          Option.match({
            onNone: () => Effect.fail(new NotFound({ reason: 'UnknownListing', evidence: { listing } })),
            onSome: (found) => Effect.succeed({ listing: found }),
          }),
        ),
      publish_listing: (details) =>
        Effect.gen(function* () {
          const caller = yield* currentCaller
          const listing = yield* generateId('ListingId')
          yield* asAgent(clients, caller).send((people) => people.PublishListing({ target: listing, ...details }))
          return { listing }
        }),
    })
  }),
)
