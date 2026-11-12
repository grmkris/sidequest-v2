import * as Domain from '@alchemy.run/domain'
import { Agreement, JobId } from '@sidequest/protocol'
import { scopedRejections } from '../Authority.ts'
import { NotPermitted } from '../NotPermitted.rejection.ts'
import { Session } from '../Session.middleware.ts'
import { NamedProposal, namedRejections } from './NamedProposal.ts'
import { WrongState } from './WrongState.rejection.ts'

export class ProposalAccepted extends Domain.Event('ProposalAccepted', { agreement: Agreement }) {}

/** The buyer, or their agent with `accept`, binds one exact proposal version. The job is awarded. */
export class AcceptProposal extends Domain.Command('AcceptProposal', {
  target: JobId,
  middleware: [Session],
  input: NamedProposal,
  events: [ProposalAccepted],
  rejects: [...scopedRejections, WrongState, NotPermitted, ...namedRejections],
}) {}
