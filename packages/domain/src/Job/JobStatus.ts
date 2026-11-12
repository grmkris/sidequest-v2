import {
  AccountId,
  Agreement,
  Bps,
  Digest,
  DisputeReason,
  type JobStage,
  ProposalId,
  ProposalVersion,
  Terms,
  UnixSeconds,
} from '@sidequest/protocol'
import { Effect, Match, Predicate, Schema } from 'effect'
import { WrongState } from './WrongState.rejection.ts'

/** A bidder's latest proposal version: the only one the buyer may accept or ask to change. */
const Head = Schema.Struct({ proposal: ProposalId, version: ProposalVersion, terms: Terms, termsDigest: Digest })
export type Head = typeof Head.Type

export const Open = Schema.TaggedStruct('Open', {
  buyer: AccountId,
  expiresAt: UnixSeconds,
  heads: Schema.Record(AccountId, Head),
})
export const Awarded = Schema.TaggedStruct('Awarded', { agreement: Agreement })
export const Funded = Schema.TaggedStruct('Funded', {
  agreement: Agreement,
  /** The artifact the worker handed over, which they sign to post on chain; null until they do. */
  artifactHash: Schema.NullOr(Digest),
})
/** Why the buyer rejected, once they said so: the first reason stands. */
const Reason = Schema.NullOr(DisputeReason)

export const Delivered = Schema.TaggedStruct('Delivered', {
  agreement: Agreement,
  /** The delivery's hash as the chain recorded it: what the buyer's approval or rejection names. */
  artifactHash: Digest,
  /** From the chain-observed delivery time plus the agreed review window. */
  reviewEndsAt: UnixSeconds,
  reason: Reason,
})
export const Disputed = Schema.TaggedStruct('Disputed', {
  agreement: Agreement,
  workerShareBps: Schema.NullOr(Bps),
  reason: Reason,
})
export const Settled = Schema.TaggedStruct('Settled', {
  /** The agreement the escrow settled; its payment stays readable on chain. */
  agreement: Schema.NullOr(Agreement),
  buyer: AccountId,
  worker: AccountId,
  reviewed: Schema.Array(AccountId),
})

/** The Job aggregate's state: only what its decisions need, one shape per stage. */
export const JobStatus = Schema.Union([
  Schema.TaggedStruct('Unposted', {}),
  Open,
  Awarded,
  Funded,
  Delivered,
  Disputed,
  Settled,
  Schema.TaggedStruct('Cancelled', {}),
  Schema.TaggedStruct('Expired', {}),
])
export type JobStatus = typeof JobStatus.Type

type Stage = JobStage

/** The stage a state is in, for a rejection's evidence. */
export const stageOf = (state: JobStatus): Stage =>
  Match.valueTags(state, {
    Unposted: (): Stage => 'Unposted',
    Open: (): Stage => 'Open',
    Awarded: (): Stage => 'Awarded',
    Funded: (): Stage => 'Funded',
    Delivered: (): Stage => 'Delivered',
    Disputed: (): Stage => 'Disputed',
    Settled: (): Stage => 'Settled',
    Cancelled: (): Stage => 'Cancelled',
    Expired: (): Stage => 'Expired',
  })

const wrong = (state: JobStatus, expected: ReadonlyArray<Stage>) =>
  Effect.fail(new WrongState({ state: stageOf(state), expected }))

export const inUnposted = (state: JobStatus) =>
  Predicate.isTagged(state, 'Unposted') ? Effect.succeed(state) : wrong(state, ['Unposted'])
export const inOpen = (state: JobStatus) =>
  Predicate.isTagged(state, 'Open') ? Effect.succeed(state) : wrong(state, ['Open'])
export const inAwarded = (state: JobStatus) =>
  Predicate.isTagged(state, 'Awarded') ? Effect.succeed(state) : wrong(state, ['Awarded'])
export const inFunded = (state: JobStatus) =>
  Predicate.isTagged(state, 'Funded') ? Effect.succeed(state) : wrong(state, ['Funded'])
export const inDelivered = (state: JobStatus) =>
  Predicate.isTagged(state, 'Delivered') ? Effect.succeed(state) : wrong(state, ['Delivered'])
export const inDisputed = (state: JobStatus) =>
  Predicate.isTagged(state, 'Disputed') ? Effect.succeed(state) : wrong(state, ['Disputed'])
export const inSettled = (state: JobStatus) =>
  Predicate.isTagged(state, 'Settled') ? Effect.succeed(state) : wrong(state, ['Settled'])

/** Where the buyer may say why they rejected: delivered (the chain has yet to report the rejection) or disputed. */
export const inReview = (state: JobStatus) =>
  Predicate.isTagged(state, 'Delivered') || Predicate.isTagged(state, 'Disputed')
    ? Effect.succeed(state)
    : wrong(state, ['Delivered', 'Disputed'])

/** Where escrowed money can still move: funded, delivered or disputed. */
export const inEscrow = (state: JobStatus) =>
  Predicate.isTagged(state, 'Funded') || Predicate.isTagged(state, 'Delivered') || Predicate.isTagged(state, 'Disputed')
    ? Effect.succeed(state)
    : wrong(state, ['Funded', 'Delivered', 'Disputed'])
