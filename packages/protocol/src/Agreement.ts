import { Schema } from 'effect'
import { Digest } from './Digest.ts'
import { AccountId, JobId, ProposalId } from './Id.ts'
import { ProposalVersion } from './Proposal.ts'
import { Terms } from './Terms.ts'

/** The exact proposal version a buyer accepted. A message never amends it. */
export const Agreement = Schema.Struct({
  job: JobId,
  buyer: AccountId,
  worker: AccountId,
  proposal: ProposalId,
  version: ProposalVersion,
  terms: Terms,
  termsDigest: Digest,
})
export type Agreement = typeof Agreement.Type
