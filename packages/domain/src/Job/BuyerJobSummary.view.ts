import * as Domain from '@alchemy.run/domain'
import { Agreement, Delivery, Proposal, Receipt, Review, UnixSeconds, WorkRequest } from '@sidequest/protocol'
import { Effect, Schema } from 'effect'
import { asViewer, viewerRejections } from '../Authority.ts'
import { NotPermitted } from '../NotPermitted.rejection.ts'
import { Session } from '../Session.middleware.ts'
import { Bps } from './Bps.ts'
import { Job } from './Job.aggregate.ts'
import { NamedProposal } from './NamedProposal.ts'
import { DeliveryRejected } from './RejectDelivery.command.ts'
import { JobSettled } from './RecordSettlement.command.ts'
import { RulingRecorded } from './RecordRuling.command.ts'
import { stageChanges } from './StageChanges.ts'
import { JobStage } from './WrongState.rejection.ts'

/** The window the buyer has to approve or reject a delivery observed on chain. */
const ReviewWindow = Schema.Struct({
  deliveredAt: UnixSeconds,
  reviewEndsAt: UnixSeconds,
  approvedAt: Schema.NullOr(UnixSeconds),
})

const Dispute = Schema.Struct({
  reason: DeliveryRejected.fields.reason,
  workerShareBps: Schema.NullOr(Bps),
  ruling: Schema.NullOr(RulingRecorded.fields.ruling),
})

const BuyerView = Schema.Struct({
  request: Schema.NullOr(WorkRequest),
  state: JobStage,
  /** Every version of every bidder's proposals, in the order they arrived. */
  proposals: Schema.Array(Proposal),
  changesRequested: Schema.Array(Schema.Struct(NamedProposal)),
  agreement: Schema.NullOr(Agreement),
  funding: Schema.NullOr(Receipt),
  delivery: Schema.NullOr(Delivery),
  review: Schema.NullOr(ReviewWindow),
  dispute: Schema.NullOr(Dispute),
  outcome: Schema.NullOr(JobSettled.fields.outcome),
  settlement: Schema.Array(Receipt),
  reviews: Schema.Array(Review),
})
export type BuyerView = typeof BuyerView.Type

/** The buyer's view before the request is posted. */
export const unpostedBuyerView: BuyerView = {
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
  state: BuyerView,
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
