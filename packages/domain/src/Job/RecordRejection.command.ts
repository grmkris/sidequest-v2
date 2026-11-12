import * as Domain from '@alchemy.run/domain'
import { JobId, UnixSeconds } from '@sidequest/protocol'
import { Session } from '../Session.middleware.ts'
import { SystemOnly } from '../SystemOnly.rejection.ts'
import { WrongState } from './WrongState.rejection.ts'

export class RejectionRecorded extends Domain.Event('RejectionRecorded', {
  rejectedAt: UnixSeconds,
  arbitrationEndsAt: UnixSeconds,
}) {}

/**
 * The settlement saga reports the buyer's rejection the chain recorded, and its block time. The dispute and the
 * arbitration windows run from that chain time.
 */
export class RecordRejection extends Domain.Command('RecordRejection', {
  target: JobId,
  middleware: [Session],
  input: { rejectedAt: UnixSeconds },
  events: [RejectionRecorded],
  rejects: [SystemOnly, WrongState],
}) {}
