import type { Party } from '@sidequest/domain/Actor'
import {
  type AccountId,
  Amount,
  type BidderBid,
  type JobId,
  type JobView,
  NotFound,
  type PublicJobView,
  roomIdOf,
  type RoomRef,
  type WorkerFee,
} from '@sidequest/protocol'
import { Array, Effect, Option } from 'effect'
import type { PeopleClients } from './People.ts'
import { refused } from './Refusals.ts'

/** The fee the escrow takes from the worker's pay, at `bps` of the amount they won, rounded down as the escrow does. */
const feeOn = (bid: BidderBid, feeBps: Option.Option<number>): WorkerFee | null =>
  Option.getOrNull(
    Option.flatMap(
      Option.filter(Array.last(bid.proposals), () => bid.outcome === 'won'),
      (won) =>
        Option.map(feeBps, (bps) => ({
          bps,
          amount: Amount.make(((BigInt(won.terms.amount) * BigInt(bps)) / 10_000n).toString()),
        })),
    ),
  )

/**
 * A job as the one asking sees it. Anyone reads the public summary; its buyer reads the buyer's summary, and a bidder
 * the request and its stage from the public summary with their own bid from their negotiation's, plus, once they
 * won, the escrow's fee on their pay. Each private summary's `validate` decides who may read it; this only picks the one that
 * fits who asks, and falls back to the public summary when no private one admits them (yet: views follow events
 * eventually). A job never posted is `NotFound`. An agent sees what its operator sees, while its grant is live.
 */
export const jobViewFor = (clients: PeopleClients['Service'], job: JobId, viewer: Party | undefined) =>
  Effect.gen(function* () {
    const people = yield* clients.as(viewer)
    const account = viewer?.account
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
    const asBidder: JobView = bid === null ? shown : { audience: 'bidder', view: bidderView(summary, bid, clients) }
    return asBidder
  }).pipe(Effect.scoped)

const bidderView = (summary: PublicJobView, bid: BidderBid, clients: PeopleClients['Service']) => ({
  ...summary,
  ...bid,
  fee: feeOn(bid, clients.feeBps),
})

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
