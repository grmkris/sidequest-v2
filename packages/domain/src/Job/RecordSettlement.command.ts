import * as Domain from '@alchemy.run/domain'
import { AccountId, JobId, Receipt } from '@sidequest/protocol'
import { Schema } from 'effect'
import { Session } from '../Session.middleware.ts'
import { SystemOnly } from '../SystemOnly.rejection.ts'
import { ReceiptMismatch } from './ReceiptMismatch.rejection.ts'
import { WrongState } from './WrongState.rejection.ts'

export class JobSettled extends Domain.Event('JobSettled', {
  buyer: AccountId,
  worker: AccountId,
  outcome: Schema.Literals(['paid', 'refunded', 'split']),
  receipts: Schema.NonEmptyArray(Receipt),
}) {}

/**
 * The settlement saga reports the capture, void or reclaim the chain reader verified. Captures pay the worker; voids
 * and reclaims return money to the buyer; both together are a split. Undelivered work can only be refunded.
 */
export class RecordSettlement extends Domain.Command('RecordSettlement', {
  target: JobId,
  middleware: [Session],
  input: { receipts: Schema.NonEmptyArray(Receipt) },
  events: [JobSettled],
  rejects: [SystemOnly, WrongState, ReceiptMismatch],
}) {}
