import * as Domain from '@alchemy.run/domain'
import { AccountId, Agreement, JobId, ProposalVersion } from '@sidequest/protocol'
import { scopedRejections } from '../Authority.ts'
import { NotPermitted } from '../NotPermitted.rejection.ts'
import { Session } from '../Session.middleware.ts'
import { NamedProposal, namedRejections } from './NamedProposal.ts'
import { WrongState } from './WrongState.rejection.ts'

export class ProposalAccepted extends Domain.Event('ProposalAccepted', { agreement: Agreement }) {}

/** Another bidder's head proposal was not chosen when the job was awarded. */
export class ProposalDeclined extends Domain.Event('ProposalDeclined', {
  bidder: AccountId,
  version: ProposalVersion,
}) {}

/**
 * The buyer, or their agent with `accept`, binds one exact proposal version. The job is awarded, and every other
 * bidder's head proposal is declined.
 */
export class AcceptProposal extends Domain.Command('AcceptProposal', {
  target: JobId,
  middleware: [Session],
  input: NamedProposal,
  events: [ProposalAccepted, ProposalDeclined],
  rejects: [...scopedRejections, WrongState, NotPermitted, ...namedRejections],
}) {}
