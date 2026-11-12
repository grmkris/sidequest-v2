import * as Domain from '@alchemy.run/domain'
import { JobId, Receipt } from '@sidequest/protocol'
import { Session } from '../Session.middleware.ts'
import { SystemOnly } from '../SystemOnly.rejection.ts'
import { ReceiptMismatch } from './ReceiptMismatch.rejection.ts'
import { WrongState } from './WrongState.rejection.ts'

export class FundingRecorded extends Domain.Event('FundingRecorded', { receipt: Receipt }) {}

/** The settlement saga reports the escrow authorization the chain reader verified for this job. */
export class RecordFunding extends Domain.Command('RecordFunding', {
  target: JobId,
  middleware: [Session],
  input: { receipt: Receipt },
  events: [FundingRecorded],
  rejects: [SystemOnly, WrongState, ReceiptMismatch],
}) {}
