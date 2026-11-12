import { Schema } from 'effect'
import { Digest } from './Digest.ts'
import { AccountId, JobId, ProposalId } from './Id.ts'
import { Terms } from './Terms.ts'

export const ProposalVersion = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }))

/** One version of a bidder's offer on a job. Version 1 has no `previous`; later versions name `version - 1`. */
export const Proposal = Schema.Struct({
  id: ProposalId,
  job: JobId,
  bidder: AccountId,
  version: ProposalVersion,
  previous: Schema.optionalKey(ProposalVersion),
  terms: Terms,
  termsDigest: Digest,
}).check(
  Schema.makeFilter(
    (proposal) =>
      proposal.version === 1 ? proposal.previous === undefined : proposal.previous === proposal.version - 1,
    { expected: 'previousIsVersionMinusOne' },
  ),
)
export type Proposal = typeof Proposal.Type
