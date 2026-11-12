import * as Domain from '@alchemy.run/domain'
import { Schema } from 'effect'

/** A verified receipt does not match this job's agreement; the job does not change. */
export class ReceiptMismatch extends Domain.Rejection('ReceiptMismatch', {
  field: Schema.Literals(['job', 'operation', 'status', 'rail', 'network', 'asset', 'amount']),
  expected: Schema.String,
  observed: Schema.String,
}) {}
