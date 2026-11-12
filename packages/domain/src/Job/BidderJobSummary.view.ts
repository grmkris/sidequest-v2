import * as Domain from '@alchemy.run/domain'
import { AccountId, JobId, Proposal, ProposalVersion, roomIdOf } from '@sidequest/protocol'
import { Effect, Schema } from 'effect'
import { asViewer, viewerRejections } from '../Authority.ts'
import { NotPermitted } from '../NotPermitted.rejection.ts'
import { Room } from '../Rooms/Room.aggregate.ts'
import { Session } from '../Session.middleware.ts'
import { Job } from './Job.aggregate.ts'

/** Where a bid stands: open, or once the job is awarded, won or lost. */
const BidOutcome = Schema.Literals(['pending', 'won', 'lost'])

const BidderView = Schema.Struct({
  job: Schema.NullOr(JobId),
  bidder: Schema.NullOr(AccountId),
  proposals: Schema.Array(Proposal),
  changesRequested: Schema.Array(ProposalVersion),
  outcome: BidOutcome,
})
export type BidderView = typeof BidderView.Type

/** A bidder's view before their first proposal. */
export const noBid: BidderView = { job: null, bidder: null, proposals: [], changesRequested: [], outcome: 'pending' }

/** The negotiation room of one bidder on a job: the key of that bidder's view. */
const negotiation = (job: JobId, bidder: AccountId) => Room.ref(roomIdOf({ job, kind: 'negotiation', bidder }))

/**
 * One bidder's side of a job, for that bidder and their agents: only their own proposals, the versions the buyer asked
 * them to change and, once the job is awarded, whether they won. Keyed by their negotiation room, which names exactly
 * the job and the bidder.
 */
export class BidderJobSummary extends Domain.View('BidderJobSummary', {
  from: [Job],
  key: Room,
  middleware: [Session],
  rejects: [...viewerRejections, NotPermitted],
  state: BidderView,
  initial: noBid,
  keyOf: {
    ProposalSubmitted: ({ event }) => negotiation(event.proposal.job, event.proposal.bidder),
    ChangeRequested: ({ source, event }) => negotiation(source.id, event.bidder),
    ProposalAccepted: ({ event }) => negotiation(event.agreement.job, event.agreement.worker),
    ProposalDeclined: ({ source, event }) => negotiation(source.id, event.bidder),
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
  },
  validate: Effect.fn(function* (_request, view) {
    const account = yield* asViewer()
    if (view?.bidder !== account) return yield* new NotPermitted({ account, required: 'bidder' })
  }),
}) {}
