import { Context, Effect, Option, Schema } from 'effect'

/** A log as the RPC returned it, kept undecoded so the reader verifies it the same way whether new or stored. */
export const RawLog = Schema.Struct({
  address: Schema.String,
  topics: Schema.Array(Schema.String),
  data: Schema.String,
  blockNumber: Schema.String,
  transactionHash: Schema.NullOr(Schema.String),
  logIndex: Schema.NullOr(Schema.Int),
})
export type RawLog = typeof RawLog.Type

/**
 * How far the reader has scanned one payment's logs, and what it found: only blocks at the confirmation depth are
 * ever scanned, so what is stored no longer changes with a reorganisation the depth covers.
 */
export const Cursor = Schema.Struct({ scannedTo: Schema.String, logs: Schema.Array(RawLog) })
export type Cursor = typeof Cursor.Type

/** A settlement store could not be read or written. */
export class SettlementStoreError extends Schema.TaggedError<SettlementStoreError>()('SettlementStoreError', {
  store: Schema.String,
}) {}

/** The reader's scan positions, per payment hash. D1 on the server, memory in tests. */
export class ReaderCursors extends Context.Service<
  ReaderCursors,
  {
    readonly load: (paymentHash: string) => Effect.Effect<Option.Option<Cursor>, SettlementStoreError>
    readonly save: (paymentHash: string, cursor: Cursor) => Effect.Effect<void, SettlementStoreError>
  }
>()('Sidequest/Settlement/ReaderCursors') {}

/** Reader cursors in memory. */
export const memoryReaderCursors = (): ReaderCursors['Service'] => {
  const cursors = new Map<string, Cursor>()
  return {
    load: (paymentHash) => Effect.sync(() => Option.fromNullishOr(cursors.get(paymentHash))),
    save: (paymentHash, cursor) => Effect.sync(() => void cursors.set(paymentHash, cursor)),
  }
}
