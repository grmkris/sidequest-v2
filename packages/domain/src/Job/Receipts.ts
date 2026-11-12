import type { Agreement, Amount, Receipt } from '@sidequest/protocol'
import { Effect } from 'effect'
import { ReceiptMismatch } from './ReceiptMismatch.rejection.ts'

type Expected = {
  readonly agreement: Agreement
  readonly operations: ReadonlyArray<Receipt['operation']>
  readonly amount?: Amount
}

/** Fails with the first field of `receipt` that does not match the agreement and the operations expected. */
export const matchReceipt = (receipt: Receipt, { agreement, operations, amount }: Expected) => {
  const checks: ReadonlyArray<readonly [ReceiptMismatch['field'], string, string]> = [
    ['job', agreement.job, receipt.job],
    [
      'operation',
      operations.includes(receipt.operation) ? receipt.operation : operations.join(' or '),
      receipt.operation,
    ],
    ['status', 'success', receipt.status],
    ['rail', agreement.terms.rail, receipt.rail],
    ['network', agreement.terms.network, receipt.network],
    ['asset', agreement.terms.asset, receipt.asset],
    ['amount', amount ?? receipt.amount, receipt.amount],
  ]
  const mismatch = checks.find(([, expected, observed]) => expected !== observed)
  return mismatch === undefined
    ? Effect.void
    : Effect.fail(new ReceiptMismatch({ field: mismatch[0], expected: mismatch[1], observed: mismatch[2] }))
}
