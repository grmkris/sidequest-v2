import { AccountId, Agreement, Digest, ProposalId, ProposalVersion, Terms, UnixSeconds } from '@sidequest/protocol'
import { Effect, Match, Predicate, Schema } from 'effect'
import { Bps } from './Bps.ts'
import { type JobStage, WrongState } from './WrongState.rejection.ts'

/** A bidder's latest proposal version: the only one the buyer may accept or ask to change. */
const Head = Schema.Struct({ proposal: ProposalId, version: ProposalVersion, terms: Terms, termsDigest: Digest })
export type Head = typeof Head.Type

export const Open = Schema.TaggedStruct('Open', {
  buyer: AccountId,
  expiresAt: UnixSeconds,
  heads: Schema.Record(AccountId, Head),
})
export const Awarded = Schema.TaggedStruct('Awarded', { agreement: Agreement })
export const Funded = Schema.TaggedStruct('Funded', { agreement: Agreement })
export const Delivered = Schema.TaggedStruct('Delivered', {
  agreement: Agreement,
  /** From the chain-observed delivery time plus the agreed review window. */
  reviewEndsAt: UnixSeconds,
  approvedAt: Schema.NullOr(UnixSeconds),
})
export const Disputed = Schema.TaggedStruct('Disputed', { agreement: Agreement, workerShareBps: Schema.NullOr(Bps) })
export const Settled = Schema.TaggedStruct('Settled', {
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

type Stage = typeof JobStage.Type

/** The stage a state is in, for a rejection's evidence. */
const stageOf = (state: JobStatus): Stage =>
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

/** Where escrowed money can still move: funded, delivered or disputed. */
export const inEscrow = (state: JobStatus) =>
  Predicate.isTagged(state, 'Funded') || Predicate.isTagged(state, 'Delivered') || Predicate.isTagged(state, 'Disputed')
    ? Effect.succeed(state)
    : wrong(state, ['Funded', 'Delivered', 'Disputed'])
