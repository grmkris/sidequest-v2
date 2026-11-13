import { EventId, PublicKey } from '@sidequest/nostr'
import {
  DeliveryNoteContent,
  JobProposalContent,
  JobRequestContent,
  JobReviewContent,
  StatementContent,
} from '@sidequest/nostr/vocabulary'
import { Bytes32, UnixSeconds } from '@sidequest/protocol'
import { Effect, Schema } from 'effect'
import { ChainDelivered, ChainEnding, ChainFunded, ChainRejected } from './ChainFacts.ts'
import { GrantRefusal } from './Grants.ts'

/**
 * Where a job is. Before funding it comes from events alone: `open` (no live proposal), `proposed`, `accepted` (the
 * buyer signed an accept matching a proposal; a signal, nothing binds) and `closed` (the buyer withdrew the request).
 * From funding on it comes from chain facts alone: `funded`, `delivered`, `rejected`, and the settled stages
 * `released` (approved or accepted by silence: paid in full), `ruled` (an arbitrator's split), `refunded` (nothing
 * delivered by the deadline, or a dispute left unruled) and `reclaimed` (the payer took the escrow back after expiry).
 */
export const Stage = Schema.Literals([
  'open',
  'proposed',
  'accepted',
  'closed',
  'funded',
  'delivered',
  'rejected',
  'released',
  'ruled',
  'refunded',
  'reclaimed',
])
export type Stage = typeof Stage.Type

/** The settled stages: the escrow paid out, split, refunded or was reclaimed. */
export const settledStages: ReadonlySet<Stage> = new Set(['released', 'ruled', 'refunded', 'reclaimed'])

/** Who signed an event and when they said they did; `createdAt` orders display only. */
const signed = { id: EventId, author: PublicKey, createdAt: UnixSeconds }

/**
 * Whose a proposal, accept, statement or delivery note is (`Grants.ts`): `by: 'self'`, its `author`'s; `by: 'agent'`,
 * `operator`'s, whose grant `grant` let the agent key `author` sign it. `grant` is also set, with `grantRefusal` saying
 * why, when the event names a grant that does not authorise it; it then counts as its author's own. Each decodes to
 * its default when absent, so a view served before grants counted still reads as the author's own.
 */
const acting = {
  by: Schema.Literals(['self', 'agent']).pipe(Schema.withDecodingDefaultKey(Effect.succeed('self' as const))),
  operator: Schema.NullOr(PublicKey).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  grant: Schema.NullOr(EventId).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  grantRefusal: Schema.NullOr(GrantRefusal).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
}

/**
 * The request. `expired`: `now` is at or past its `expiresAt` (a label; the job stays open). `closedByBuyer`: its
 * author signed a `withdraw_request` statement for it, which still shows once the job is funded.
 */
export const RequestView = Schema.Struct({
  ...signed,
  content: JobRequestContent,
  expired: Schema.Boolean,
  closedByBuyer: Schema.Boolean,
})
export type RequestView = typeof RequestView.Type

/**
 * One proposal; the bidder is its `operator` when an agent made it under their grant, else its `author`. Labels:
 * - `superseded`: a later proposal by the same bidder names this one as `previous`;
 * - `withdrawn`: its bidder (themselves, or an agent under their grant) signed a `withdraw_proposal` statement about
 *   it;
 * - `expired`: `now` is at or past its `validUntil`;
 * - `accepted`: the buyer signed an accept that matches it (see `AcceptView.matchesProposal`);
 * - `funded`: it is the proposal the chain funded, whatever its other labels say;
 * - `otherBuyer`: it names a buyer other than the request's author.
 */
export const ProposalView = Schema.Struct({
  ...signed,
  ...acting,
  content: JobProposalContent,
  superseded: Schema.Boolean,
  withdrawn: Schema.Boolean,
  expired: Schema.Boolean,
  accepted: Schema.Boolean,
  funded: Schema.Boolean,
  otherBuyer: Schema.Boolean,
})
export type ProposalView = typeof ProposalView.Type

/**
 * One accept: a signal, never a commitment. Labels:
 * - `fromBuyer`: it is the request's author's: they signed it, or an agent under their grant with the `accept` scope
 *   did (only those count towards `accepted`);
 * - `matchesProposal`: the proposal it names is known, and its terms digest, worker and network are that proposal's;
 * - `conflicting`: the buyer also accepted a different proposal. Harmless: only the chain decides.
 */
export const AcceptView = Schema.Struct({
  ...signed,
  ...acting,
  proposal: EventId,
  worker: PublicKey,
  fromBuyer: Schema.Boolean,
  matchesProposal: Schema.Boolean,
  conflicting: Schema.Boolean,
})
export type AcceptView = typeof AcceptView.Type

/**
 * The escrow payment that makes the job real: the earliest `JobFunded` for this job by log position. Labels:
 * - `proposal`: the funded proposal, whose job, terms digest and `payTo` are the chain's job, terms digest and
 *   receiver; `null` with `terms: 'unknown'` when no known proposal matches;
 * - `termsAmbiguous`: more than one known proposal matches (the accepted one, then the lowest id, is chosen);
 * - `termsMatchChain`: the funded proposal's amount, asset, delivery deadline and windows are the chain's;
 * - `payerLinked`: the on-chain payer's wallet is linked to the buyer's key;
 * - `receiverLinked`: the on-chain receiver's wallet is linked to the worker's key (the operator's, for an agent's
 *   proposal);
 * - `otherPayments`: other payments funded for the same job, which the fold ignores.
 */
export const FundingView = Schema.Struct({
  fact: ChainFunded,
  proposal: Schema.NullOr(EventId),
  terms: Schema.Literals(['known', 'unknown']),
  termsAmbiguous: Schema.Boolean,
  termsMatchChain: Schema.Boolean,
  payerLinked: Schema.Boolean,
  receiverLinked: Schema.Boolean,
  otherPayments: Schema.Array(Bytes32),
})
export type FundingView = typeof FundingView.Type

/**
 * Deadline labels, from the chain's values compared with `now`; each is false when its stage is not current.
 * `deliveryOverdue`: funded and the delivery deadline has passed (anyone may refund). `reviewWindowOpen`: delivered
 * and the buyer may still reject. `arbitrationOpen`: rejected and the arbitrator may still rule. `reclaimable`: not
 * settled and the escrow's authorisation has expired, so the payer may reclaim.
 */
export const Deadlines = Schema.Struct({
  deliveryOverdue: Schema.Boolean,
  reviewWindowOpen: Schema.Boolean,
  arbitrationOpen: Schema.Boolean,
  reclaimable: Schema.Boolean,
})
export type Deadlines = typeof Deadlines.Type

/**
 * A delivery note. `fromWorker`: it is the worker's, signed by them or by an agent under their grant with the `deliver`
 * scope (only those count). `matchesChain`: its delivery hash is the one the chain recorded.
 */
export const DeliveryNoteView = Schema.Struct({
  ...signed,
  ...acting,
  content: DeliveryNoteContent,
  fromWorker: Schema.Boolean,
  matchesChain: Schema.Boolean,
})
export type DeliveryNoteView = typeof DeliveryNoteView.Type

/**
 * A statement. `effective`: whoever it counts as may say it: the buyer withdrawing the request (about nothing or the
 * request) or giving a rejection reason, or a proposal's bidder withdrawing that proposal.
 */
export const StatementView = Schema.Struct({
  ...signed,
  ...acting,
  content: StatementContent,
  effective: Schema.Boolean,
})
export type StatementView = typeof StatementView.Type

/** Which side of the escrow a reviewer's key is linked to: the on-chain payer's wallet or the receiver's. */
export const ReviewSide = Schema.Literals(['payer', 'receiver'])
export type ReviewSide = typeof ReviewSide.Type

/**
 * A review. `side`: the escrow side its author's key is linked to (payer first), `null` when neither or unfunded.
 * `status`: `counted` (the one review of its side: the latest by `createdAt`, ties to the lowest id), `replaced` (its
 * side has a later one), `stranger` (its author is linked to neither side) or `jobNotSettled`.
 */
export const ReviewView = Schema.Struct({
  ...signed,
  content: JobReviewContent,
  side: Schema.NullOr(ReviewSide),
  status: Schema.Literals(['counted', 'replaced', 'stranger', 'jobNotSettled']),
})
export type ReviewView = typeof ReviewView.Type

/**
 * One job as a pure function of its signed events, the chain's facts, the wallet links and the grants. `buyer` is the
 * request's author, `worker` the funded proposal's bidder: its author, or the operator whose agent made it under their
 * grant (`null` before funding or when the terms are unknown). The chain facts
 * are the funding payment's first delivery after funding, first rejection after that delivery and first ending after
 * funding. Every list is in display order: by `createdAt`, then id.
 */
export const JobView = Schema.Struct({
  job: EventId,
  stage: Stage,
  buyer: PublicKey,
  worker: Schema.NullOr(PublicKey),
  request: RequestView,
  proposals: Schema.Array(ProposalView),
  accepts: Schema.Array(AcceptView),
  funding: Schema.NullOr(FundingView),
  delivery: Schema.NullOr(ChainDelivered),
  rejection: Schema.NullOr(ChainRejected),
  ending: Schema.NullOr(ChainEnding),
  deadlines: Deadlines,
  deliveryNotes: Schema.Array(DeliveryNoteView),
  statements: Schema.Array(StatementView),
  reviews: Schema.Array(ReviewView),
})
export type JobView = typeof JobView.Type
