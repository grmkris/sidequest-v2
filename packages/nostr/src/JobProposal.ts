import { AccountRef, Digest, Terms, termsDigest, UnixSeconds } from '@sidequest/protocol'
import { Effect, Schema } from 'effect'
import { EventId } from './Event.ts'
import { PublicKey } from './Keys.ts'
import type { KindSpec } from './KindSpec.ts'
import { sidequestKinds } from './Kinds.ts'
import { eventTag, optionalTag, personTag } from './RoutingTags.ts'

/**
 * A bidder offers terms for a job (kind 8412). Its event id is the proposal's id; `previous` names the proposal it
 * revises. `termsDigest` is what an accept binds, so the parser recomputes it from `terms`. Payment goes to `payTo`,
 * which must be on the terms' network, and the money's network is the terms' (`sq-net` must equal it).
 */
export const JobProposalContent = Schema.Struct({
  job: EventId,
  buyer: PublicKey,
  terms: Terms,
  termsDigest: Digest,
  payTo: AccountRef,
  validUntil: UnixSeconds,
  previous: Schema.optionalKey(EventId),
}).check(
  Schema.makeFilter((proposal) => proposal.payTo.startsWith(`${proposal.terms.network}:`), {
    expected: 'payToOnTermsNetwork',
  }),
)
export type JobProposalContent = typeof JobProposalContent.Type

export const jobProposal: KindSpec<JobProposalContent> = {
  kind: sidequestKinds.proposal,
  content: JobProposalContent,
  routing: (content) => [eventTag(content.job), personTag(content.buyer), ...optionalTag(content.previous, eventTag)],
  network: (content) => content.terms.network,
  check: (content) => Effect.map(termsDigest(content.terms), (digest) => digest === content.termsDigest),
}
