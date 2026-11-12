import * as Domain from '@alchemy.run/domain'
import { JobId } from '@sidequest/protocol'
import { scopedRejections } from '../Authority.ts'
import { NotPermitted } from '../NotPermitted.rejection.ts'
import { Session } from '../Session.middleware.ts'
import { NamedProposal, namedRejections } from './NamedProposal.ts'
import { WrongState } from './WrongState.rejection.ts'

export class ChangeRequested extends Domain.Event('ChangeRequested', NamedProposal) {}

/** The buyer, or their agent with `discuss`, asks a bidder to change their head proposal. */
export class RequestChange extends Domain.Command('RequestChange', {
  target: JobId,
  middleware: [Session],
  input: NamedProposal,
  events: [ChangeRequested],
  rejects: [...scopedRejections, WrongState, NotPermitted, ...namedRejections],
}) {}
