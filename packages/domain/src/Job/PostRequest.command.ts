import * as Domain from '@alchemy.run/domain'
import { JobId, WorkRequest } from '@sidequest/protocol'
import { scopedRejections } from '../Authority.ts'
import { ExpiryNotInFuture } from '../ExpiryNotInFuture.rejection.ts'
import { Session } from '../Session.middleware.ts'
import { WrongState } from './WrongState.rejection.ts'

export class RequestPosted extends Domain.Event('RequestPosted', { request: WorkRequest }) {}

/** A buyer, or their agent with `discuss`, asks for work. The job opens until `expiresAt`. */
export class PostRequest extends Domain.Command('PostRequest', {
  target: JobId,
  middleware: [Session],
  input: {
    title: WorkRequest.fields.title,
    description: WorkRequest.fields.description,
    expiresAt: WorkRequest.fields.expiresAt,
  },
  events: [RequestPosted],
  rejects: [...scopedRejections, WrongState, ExpiryNotInFuture],
}) {}
