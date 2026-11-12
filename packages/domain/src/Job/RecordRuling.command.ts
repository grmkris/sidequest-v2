import * as Domain from '@alchemy.run/domain'
import { JobId } from '@sidequest/protocol'
import { Schema } from 'effect'
import { Session } from '../Session.middleware.ts'
import { SystemOnly } from '../SystemOnly.rejection.ts'
import { Bps } from './Bps.ts'
import { WrongState } from './WrongState.rejection.ts'

/** The arbitrator ruled on this dispute already. */
export class AlreadyRuled extends Domain.Rejection('AlreadyRuled', { workerShareBps: Bps }) {}

export class RulingRecorded extends Domain.Event('RulingRecorded', {
  workerShareBps: Bps,
  ruling: Schema.Literals(['pay', 'refund', 'split']),
}) {}

/** The settlement saga reports the arbitrator's verified ruling: the worker's share in basis points. */
export class RecordRuling extends Domain.Command('RecordRuling', {
  target: JobId,
  middleware: [Session],
  input: { workerShareBps: Bps },
  events: [RulingRecorded],
  rejects: [SystemOnly, WrongState, AlreadyRuled],
}) {}
