import * as Domain from '@alchemy.run/domain'
import { JobId } from '@sidequest/protocol'
import { personRejections } from '../Authority.ts'
import { NotPermitted } from '../NotPermitted.rejection.ts'
import { Session } from '../Session.middleware.ts'
import { WrongState } from './WrongState.rejection.ts'

export class RequestCancelled extends Domain.Event('RequestCancelled') {}

/** The buyer withdraws an open request. */
export class CancelRequest extends Domain.Command('CancelRequest', {
  target: JobId,
  middleware: [Session],
  events: [RequestCancelled],
  rejects: [...personRejections, WrongState, NotPermitted],
}) {}
