import { SidequestApi, SignedInAccount } from '@sidequest/protocol'
import { Effect, Option } from 'effect'
import { HttpApiBuilder } from 'effect/http-api'
import { AccountNameReads } from '../Reads/AccountNameReads.ts'
import { ListingReads } from '../Reads/ListingReads.ts'
import { PartyJobReads } from '../Reads/PartyJobReads.ts'
import { PeopleClients, signedIn } from './People.ts'

/**
 * The `account` group: the signed-in person's account and its name, which they rename through the model; their own
 * listings and jobs from D1; and, for anyone, the names of the accounts a page shows, in one lookup.
 */
export const accountHandlers = HttpApiBuilder.group(SidequestApi, 'account', (handlers) =>
  Effect.gen(function* () {
    const names = yield* AccountNameReads
    const listings = yield* ListingReads
    const jobs = yield* PartyJobReads
    const asPerson = signedIn(yield* PeopleClients)
    return handlers
      .handle('current', () =>
        Effect.gen(function* () {
          const account = yield* SignedInAccount
          return { account, displayName: Option.getOrNull(yield* names.name(account)) }
        }),
      )
      .handle('rename', ({ payload }) =>
        Effect.gen(function* () {
          const account = yield* SignedInAccount
          yield* asPerson.send((people) => people.RenameAccount({ target: account, ...payload }))
        }),
      )
      .handle('listings', ({ query }) => Effect.flatMap(SignedInAccount, (owner) => listings.owned(owner, query)))
      .handle('jobs', ({ query: { as, ...page } }) =>
        Effect.flatMap(SignedInAccount, (account) => jobs.page(account, as, page)),
      )
      .handle('names', ({ query: { ids } }) => Effect.map(names.names(ids), (found) => ({ names: found })))
  }),
)
