import * as Domain from '@alchemy.run/domain'
import { AccountId, Digest, ProposalVersion } from '@sidequest/protocol'

/** The named terms digest is not the digest of the bidder's head version. */
export class DigestMismatch extends Domain.Rejection('DigestMismatch', {
  bidder: AccountId,
  version: ProposalVersion,
  head: Digest,
  named: Digest,
}) {}
