import * as Domain from '@alchemy.run/domain'
import { Bps, JobId, Ruling } from '@sidequest/protocol'
import { Session } from '../Session.middleware.ts'
import { SystemOnly } from '../SystemOnly.rejection.ts'
import { WrongState } from './WrongState.rejection.ts'

/** The arbitrator ruled on this dispute already. */
export class AlreadyRuled extends Domain.Rejection('AlreadyRuled', { workerShareBps: Bps }) {}

export class RulingRecorded extends Domain.Event('RulingRecorded', {
  workerShareBps: Bps,
  ruling: Ruling,
}) {}

/** The settlement saga reports the arbitrator's verified ruling: the worker's share in basis points. */
export class RecordRuling extends Domain.Command('RecordRuling', {
  target: JobId,
  middleware: [Session],
  input: { workerShareBps: Bps },
  events: [RulingRecorded],
  rejects: [SystemOnly, WrongState, AlreadyRuled],
}) {}
