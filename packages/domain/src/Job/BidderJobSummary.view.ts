import * as Domain from '@alchemy.run/domain'
import { type AccountId, BidderBid, type JobId, roomIdOf } from '@sidequest/protocol'
import { Effect, Schema } from 'effect'
import { asViewer, viewerRejections } from '../Authority.ts'
import { NotPermitted } from '../NotPermitted.rejection.ts'
import { Room } from '../Rooms/Room.aggregate.ts'
import { Session } from '../Session.middleware.ts'
import { Job } from './Job.aggregate.ts'

/** A bidder's view before their first proposal. */
export const noBid: BidderBid = {
  job: null,
  bidder: null,
  proposals: [],
  changesRequested: [],
  outcome: 'pending',
  reviews: [],
}

/** The bid as each instance stores it. A bid stored before reviews were part of it reads with none. */
const StoredBid = Schema.Struct({
  ...BidderBid.fields,
  reviews: BidderBid.fields.reviews.pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
})

/** The negotiation room of one bidder on a job: the key of that bidder's view. */
const negotiation = (job: JobId, bidder: AccountId) => Room.ref(roomIdOf({ job, kind: 'negotiation', bidder }))

/**
 * One bidder's side of a job, for that bidder and their agents: only their own proposals, the versions the buyer asked
 * them to change and, once the job is awarded, whether they won; the worker also sees the reviews either side leaves.
 * Keyed by their negotiation room, which names exactly the job and the bidder. The request and its stage are the
 * public summary's ({@link JobSummary}): no event can reach every bidder's instance, so a reader combines the two.
 */
export class BidderJobSummary extends Domain.View('BidderJobSummary', {
  from: [Job],
  key: Room,
  middleware: [Session],
  rejects: [...viewerRejections, NotPermitted],
  state: StoredBid,
  initial: noBid,
  keyOf: {
    ProposalSubmitted: ({ event }) => negotiation(event.proposal.job, event.proposal.bidder),
    ChangeRequested: ({ source, event }) => negotiation(source.id, event.bidder),
    ProposalAccepted: ({ event }) => negotiation(event.agreement.job, event.agreement.worker),
    ProposalDeclined: ({ source, event }) => negotiation(source.id, event.bidder),
    // One of the two is the worker; the buyer never bid, so their route finds no bid and keeps none.
    ReviewLeft: {
      author: ({ event }) => negotiation(event.review.job, event.review.author),
      subject: ({ event }) => negotiation(event.review.job, event.review.subject),
    },
  },
  evolve: {
    ProposalSubmitted: (view, { proposal }) => ({
      ...view,
      job: proposal.job,
      bidder: proposal.bidder,
      proposals: [...view.proposals, proposal],
    }),
    ChangeRequested: (view, { version }) => ({ ...view, changesRequested: [...view.changesRequested, version] }),
    ProposalAccepted: (view) => ({ ...view, outcome: 'won' as const }),
    ProposalDeclined: (view) => ({ ...view, outcome: 'lost' as const }),
    ReviewLeft: (view, { review }) => (view.outcome === 'won' ? { ...view, reviews: [...view.reviews, review] } : null),
  },
  validate: Effect.fn(function* (_request, view) {
    const account = yield* asViewer()
    if (view?.bidder !== account) return yield* new NotPermitted({ account, required: 'bidder' })
  }),
}) {}
