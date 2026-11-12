import * as Domain from '@alchemy.run/domain'
import { AccountId, ProposalVersion } from '@sidequest/protocol'

/** The named version is not the bidder's head: a later version replaced it. */
export class SupersededVersion extends Domain.Rejection('SupersededVersion', {
  bidder: AccountId,
  head: ProposalVersion,
  named: ProposalVersion,
}) {}
