import { Context, Effect, Option, Schema } from 'effect'
import type { SettlementStoreError } from './ReaderCursors.ts'

/**
 * One payment request as the escrow adapter keeps it: its id (from the job and the terms digest), the parties, the
 * payment hash they make, the block to read its events from, and how far it went.
 */
export const PaymentRecord = Schema.Struct({
  id: Schema.String,
  job: Schema.String,
  payer: Schema.String,
  receiver: Schema.String,
  paymentHash: Schema.String,
  fromBlock: Schema.String,
  state: Schema.Literals(['begun', 'submitted', 'cancelled']),
  transactionHash: Schema.NullOr(Schema.String),
})
export type PaymentRecord = typeof PaymentRecord.Type

/**
 * The adapter's requests. `open` records a request unless one is open under its id (begun or submitted), and returns
 * whichever is recorded; a cancelled one is replaced. `submitted` moves a begun request on, `cancelled` a begun one
 * back; each changes nothing in any other state and returns the request as it is after.
 */
export class PaymentRequests extends Context.Service<
  PaymentRequests,
  {
    readonly open: (record: PaymentRecord) => Effect.Effect<PaymentRecord, SettlementStoreError>
    readonly find: (id: string) => Effect.Effect<Option.Option<PaymentRecord>, SettlementStoreError>
    readonly submitted: (id: string, transactionHash: string) => Effect.Effect<void, SettlementStoreError>
    readonly cancelled: (id: string) => Effect.Effect<void, SettlementStoreError>
  }
>()('Sidequest/Settlement/PaymentRequests') {}

/** Payment requests in memory. */
export const memoryPaymentRequests = (): PaymentRequests['Service'] => {
  const records = new Map<string, PaymentRecord>()
  const move = (id: string, from: PaymentRecord['state'], to: (record: PaymentRecord) => PaymentRecord) =>
    Effect.sync(() => {
      const record = records.get(id)
      if (record?.state === from) records.set(id, to(record))
    })
  return {
    open: (record) =>
      Effect.sync(() => {
        const existing = records.get(record.id)
        if (existing !== undefined && existing.state !== 'cancelled') return existing
        records.set(record.id, record)
        return record
      }),
    find: (id) => Effect.sync(() => Option.fromNullishOr(records.get(id))),
    submitted: (id, transactionHash) =>
      move(id, 'begun', (record) => ({ ...record, state: 'submitted', transactionHash })),
    cancelled: (id) => move(id, 'begun', (record) => ({ ...record, state: 'cancelled' })),
  }
}
