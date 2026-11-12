import * as Domain from '@alchemy.run/domain'
import { AccountId } from '@sidequest/protocol'

/** The named bidder has not proposed on this job. */
export class NoProposal extends Domain.Rejection('NoProposal', { bidder: AccountId }) {}
