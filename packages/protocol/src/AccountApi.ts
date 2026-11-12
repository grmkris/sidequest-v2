import { Schema, SchemaTransformation } from 'effect'
import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api'
import { Account } from './Account.ts'
import { SignedIn } from './Guards.ts'
import { AccountId } from './Id.ts'
import { Listing } from './Listing.ts'
import { maxPageSize, Page, PageQuery } from './Page.ts'
import { PartyJob } from './PartyJob.ts'
import { BadCursor, refusals } from './Refusals.ts'
import { Unavailable } from './SessionApi.ts'

/** The name others see for an account. */
export const DisplayName = Account.fields.displayName

/** An account and the name others see for it. */
export const AccountName = Schema.Struct({ account: AccountId, displayName: DisplayName })
export type AccountName = typeof AccountName.Type

/** The signed-in person's account: its id and the name others see, `null` until the account's name is recorded. */
export const Profile = Schema.Struct({ account: AccountId, displayName: Schema.NullOr(DisplayName) })
export type Profile = typeof Profile.Type

/** The most accounts one names lookup takes: two pages of items, each naming a counterpart. */
export const maxNamesPerLookup = 2 * maxPageSize

/** Account ids in the query string, comma separated: one to {@link maxNamesPerLookup}, each once. */
export const AccountIds = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Array(AccountId).check(Schema.isMinLength(1), Schema.isMaxLength(maxNamesPerLookup), Schema.isUnique()),
    SchemaTransformation.transform<ReadonlyArray<string>, string>({
      decode: (ids) => ids.split(','),
      encode: (ids) => ids.join(','),
    }),
  ),
)

/** Which side of a job: the jobs an account posted, or the ones it bid on (won or not). */
export const JobSide = Schema.Literals(['buyer', 'bidder'])
export type JobSide = typeof JobSide.Type

/**
 * The signed-in person's account: read it and choose the name others see; their own listings (published or
 * withdrawn) and their jobs, as buyer or as bidder, newest first. And, for anyone, the names of the accounts a page
 * shows, in one lookup: a view names its counterparts by account id.
 */
export class AccountApi extends HttpApiGroup.make('account').add(
  HttpApiEndpoint.get('current', '/api/account', { success: Profile, error: Unavailable }).middleware(SignedIn),
  HttpApiEndpoint.put('rename', '/api/account/name', {
    payload: Schema.Struct({ displayName: DisplayName }),
    error: refusals,
  }).middleware(SignedIn),
  HttpApiEndpoint.get('listings', '/api/account/listings', {
    query: PageQuery,
    success: Page(Listing),
    error: [BadCursor, Unavailable],
  }).middleware(SignedIn),
  HttpApiEndpoint.get('jobs', '/api/account/jobs', {
    query: { as: JobSide, ...PageQuery },
    success: Page(PartyJob),
    error: [BadCursor, Unavailable],
  }).middleware(SignedIn),
  HttpApiEndpoint.get('names', '/api/accounts/names', {
    query: { ids: AccountIds },
    success: Schema.Struct({ names: Schema.Array(AccountName) }),
    error: Unavailable,
  }),
) {}
