import { type AccountId, type JobId, type JobView, NotFound, roomIdOf, type RoomRef } from '@sidequest/protocol'
import { Effect } from 'effect'
import type { PeopleClients } from './People.ts'
import { refused } from './Refusals.ts'

/**
 * A job as the one asking sees it. Anyone reads the public summary; its buyer reads the buyer's summary, and a bidder
 * their own negotiation's. Each private summary's `validate` decides who may read it; this only picks the one that
 * fits who asks, and falls back to the public summary when no private one admits them (yet: views follow events
 * eventually). A job never posted is `NotFound`.
 */
export const jobViewFor = (clients: PeopleClients['Service'], job: JobId, account: AccountId | undefined) =>
  Effect.gen(function* () {
    const people = yield* clients.as(account)
    const summary = yield* refused(people.JobSummary.get(job))
    if (summary?.request == null) return yield* new NotFound({ reason: 'UnknownJob', evidence: { job } })
    const shown: JobView = { audience: 'public', view: summary }
    if (account === undefined) return shown
    if (summary.request.buyer === account) {
      // The buyer's view follows the same events as the public one, and may not have caught up with them yet.
      const view = yield* refused(
        people.BuyerJobSummary.get(job).pipe(Effect.catchTag('NotPermitted', () => Effect.succeed(null))),
      )
      const asBuyer: JobView = view === null ? shown : { audience: 'buyer', view }
      return asBuyer
    }
    const bid = yield* refused(
      people.BidderJobSummary.get(roomIdOf({ job, kind: 'negotiation', bidder: account })).pipe(
        Effect.catchTag('NotPermitted', () => Effect.succeed(null)),
      ),
    )
    const asBidder: JobView = bid === null ? shown : { audience: 'bidder', view: bid }
    return asBidder
  }).pipe(Effect.scoped)

/**
 * The rooms of a job its reader is a member of, from their view of it: the buyer's negotiation room with each bidder
 * and, once awarded, the engagement room; a bidder's own negotiation room and, if they won, the engagement room.
 * Room ids derive from the job, so naming them needs nothing else.
 */
export const roomsIn = (job: JobId, { audience, view }: JobView): ReadonlyArray<RoomRef> => {
  const negotiation = (bidder: AccountId): RoomRef => ({
    id: roomIdOf({ job, kind: 'negotiation', bidder }),
    kind: 'negotiation',
    bidder,
  })
  const engagement: RoomRef = { id: roomIdOf({ job, kind: 'engagement' }), kind: 'engagement' }
  if (audience === 'buyer') {
    const bidders = [...new Set(view.proposals.map(({ bidder }) => bidder))]
    return [...bidders.map(negotiation), ...(view.agreement === null ? [] : [engagement])]
  }
  if (audience === 'bidder' && view.bidder !== null)
    return [negotiation(view.bidder), ...(view.outcome === 'won' ? [engagement] : [])]
  return []
}
