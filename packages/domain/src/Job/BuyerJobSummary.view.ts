import * as Domain from '@alchemy.run/domain'
import { BuyerJobView } from '@sidequest/protocol'
import { Effect } from 'effect'
import { asViewer, viewerRejections } from '../Authority.ts'
import { NotPermitted } from '../NotPermitted.rejection.ts'
import { Session } from '../Session.middleware.ts'
import { Job } from './Job.aggregate.ts'
import { stageChanges } from './StageChanges.ts'

/** The buyer's view before the request is posted. */
export const unpostedBuyerView: BuyerJobView = {
  request: null,
  state: 'Unposted',
  proposals: [],
  changesRequested: [],
  agreement: null,
  funding: null,
  delivery: null,
  review: null,
  dispute: null,
  outcome: null,
  settlement: [],
  reviews: [],
}

/** Everything about a job, for its buyer and the buyer's agents: every proposal, the agreement, money and reviews. */
export class BuyerJobSummary extends Domain.View('BuyerJobSummary', {
  from: [Job],
  key: Job,
  middleware: [Session],
  rejects: [...viewerRejections, NotPermitted],
  state: BuyerJobView,
  initial: unpostedBuyerView,
  evolve: {
    RequestPosted: (view, { request }) => ({ ...view, request, state: 'Open' as const }),
    ProposalSubmitted: (view, { proposal }) => ({ ...view, proposals: [...view.proposals, proposal] }),
    ChangeRequested: (view, { bidder, version, termsDigest }) => ({
      ...view,
      changesRequested: [...view.changesRequested, { bidder, version, termsDigest }],
    }),
    ProposalAccepted: (view, { agreement }) => ({ ...stageChanges.ProposalAccepted(view), agreement }),
    RequestCancelled: stageChanges.RequestCancelled,
    RequestExpired: stageChanges.RequestExpired,
    FundingRecorded: (view, { receipt }) => ({ ...stageChanges.FundingRecorded(view), funding: receipt }),
    DeliverySubmitted: (view, { delivery }) => ({ ...view, delivery }),
    DeliveryRecorded: (view, { deliveredAt, reviewEndsAt }) => ({
      ...stageChanges.DeliveryRecorded(view),
      review: { deliveredAt, reviewEndsAt, approvedAt: null },
    }),
    DeliveryApproved: (view, { approvedAt }) => ({
      ...view,
      review: view.review === null ? null : { ...view.review, approvedAt },
    }),
    DeliveryRejected: (view, { reason }) => ({
      ...stageChanges.DeliveryRejected(view),
      dispute: { reason, workerShareBps: null, ruling: null },
    }),
    RulingRecorded: (view, { workerShareBps, ruling }) => ({
      ...view,
      dispute: view.dispute === null ? null : { ...view.dispute, workerShareBps, ruling },
    }),
    JobSettled: (view, { outcome, receipts }) => ({ ...stageChanges.JobSettled(view), outcome, settlement: receipts }),
    ReviewLeft: (view, { review }) => ({ ...view, reviews: [...view.reviews, review] }),
  },
  validate: Effect.fn(function* (_request, view) {
    const account = yield* asViewer()
    if (view?.request?.buyer !== account) return yield* new NotPermitted({ account, required: 'buyer' })
  }),
}) {}
