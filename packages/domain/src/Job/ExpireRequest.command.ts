import * as Domain from '@alchemy.run/domain'
import { JobId } from '@sidequest/protocol'
import { Session } from '../Session.middleware.ts'

export class RequestExpired extends Domain.Event('RequestExpired') {}

/**
 * Scheduled by the system at the request's expiry. It never rejects, so it can be scheduled: it records nothing
 * unless the system sent it, the job is still open and its expiry has passed.
 */
export class ExpireRequest extends Domain.Command('ExpireRequest', {
  target: JobId,
  middleware: [Session],
  events: [RequestExpired],
}) {}
