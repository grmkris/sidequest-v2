import { Schema } from 'effect'
import { Agreement } from './Agreement.ts'
import { Amount } from './Amount.ts'
import { Delivery } from './Delivery.ts'
import { Digest } from './Digest.ts'
import { AccountId, JobId } from './Id.ts'
import { JobState } from './JobState.ts'
import { Proposal, ProposalVersion } from './Proposal.ts'
import { Receipt } from './Receipt.ts'
import { Review } from './Review.ts'
import { Text } from './Text.ts'
import { UnixSeconds } from './UnixSeconds.ts'
import { WorkRequest } from './WorkRequest.ts'

/** A job's stage, including before its request was posted. */
export const JobStage = Schema.Union([Schema.Literal('Unposted'), JobState])
export type JobStage = typeof JobStage.Type

/** A share in basis points: 0 is none, 10 000 is all. */
export const Bps = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 }))

/** How the arbitrator ruled: everything to the worker, everything back to the buyer, or a split. */
export const Ruling = Schema.Literals(['pay', 'refund', 'split'])

/** Where a settled job's money went. */
export const Outcome = Schema.Literals(['paid', 'refunded', 'split'])

/** Why the buyer rejected a delivery. */
export const DisputeReason = Text(2000)

/** How the buyer names one exact proposal version: the bidder, its version and its terms digest. */
export const ProposalRef = Schema.Struct({ bidder: AccountId, version: ProposalVersion, termsDigest: Digest })
export type ProposalRef = typeof ProposalRef.Type

/** The window the buyer has to approve or reject a delivery observed on chain; silence after it is acceptance. */
const ReviewWindow = Schema.Struct({
  deliveredAt: UnixSeconds,
  reviewEndsAt: UnixSeconds,
})

/**
 * A rejection: the buyer's stated reason (null until they give one), when the arbitrator's time ends (null until the
 * chain recorded the rejection), and the ruling once made.
 */
const Dispute = Schema.Struct({
  reason: Schema.NullOr(DisputeReason),
  arbitrationEndsAt: Schema.NullOr(UnixSeconds),
  workerShareBps: Schema.NullOr(Bps),
  ruling: Schema.NullOr(Ruling),
})

/** Everything about a job, for its buyer: every proposal, the agreement, money and reviews. */
export const BuyerJobView = Schema.Struct({
  request: Schema.NullOr(WorkRequest),
  state: JobStage,
  /** Every version of every bidder's proposals, in the order they arrived. */
  proposals: Schema.Array(Proposal),
  changesRequested: Schema.Array(ProposalRef),
  agreement: Schema.NullOr(Agreement),
  funding: Schema.NullOr(Receipt),
  delivery: Schema.NullOr(Delivery),
  review: Schema.NullOr(ReviewWindow),
  dispute: Schema.NullOr(Dispute),
  outcome: Schema.NullOr(Outcome),
  settlement: Schema.Array(Receipt),
  reviews: Schema.Array(Review),
})
export type BuyerJobView = typeof BuyerJobView.Type

/** Where a bid stands: open, or once the job is awarded, won or lost. */
export const BidOutcome = Schema.Literals(['pending', 'won', 'lost'])

/**
 * One bidder's own bid: only their proposals, the versions the buyer asked them to change, the outcome and, for the
 * worker once the job is settled, the reviews either side left.
 */
export const BidderBid = Schema.Struct({
  job: Schema.NullOr(JobId),
  bidder: Schema.NullOr(AccountId),
  proposals: Schema.Array(Proposal),
  changesRequested: Schema.Array(ProposalVersion),
  outcome: BidOutcome,
  reviews: Schema.Array(Review),
})
export type BidderBid = typeof BidderBid.Type

/** What the escrow will take from the worker's pay: its rate and the amount, in the agreed asset's atomic units. */
export const WorkerFee = Schema.Struct({ bps: Bps, amount: Amount })
export type WorkerFee = typeof WorkerFee.Type

/**
 * One bidder's side of a job: the request and its stage, as anyone sees them, and their own bid. Once they won, the fee
 * the escrow takes from their pay (`null` while settlement is not configured, or for anyone who did not win).
 */
export const BidderJobView = Schema.Struct({
  request: Schema.NullOr(WorkRequest),
  state: JobStage,
  ...BidderBid.fields,
  fee: Schema.NullOr(WorkerFee),
})
export type BidderJobView = typeof BidderJobView.Type

/** What anyone sees of a job: the request and its stage. */
export const PublicJobView = Schema.Struct({ request: Schema.NullOr(WorkRequest), state: JobStage })
export type PublicJobView = typeof PublicJobView.Type

/** A job as the one asking sees it: its buyer, one of its bidders, or anyone else. */
export const JobView = Schema.Union([
  Schema.Struct({ audience: Schema.Literal('buyer'), view: BuyerJobView }),
  Schema.Struct({ audience: Schema.Literal('bidder'), view: BidderJobView }),
  Schema.Struct({ audience: Schema.Literal('public'), view: PublicJobView }),
])
export type JobView = typeof JobView.Type
