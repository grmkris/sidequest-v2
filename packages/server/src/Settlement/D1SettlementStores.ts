import { PaymentRecord, PaymentRequests } from '@sidequest/settlement/PaymentRequests'
import { Cursor, ReaderCursors, SettlementStoreError } from '@sidequest/settlement/ReaderCursors'
import { RelayIntent, RelayerIntents } from '@sidequest/settlement/RelayerIntents'
import { Effect, Layer, Option, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

/** A store's statement failed: settlement treats it like an unreachable chain, and tries again later. */
const failed = (store: string) => () => new SettlementStoreError({ store })

/** `payment_requests`: each write is one statement that guards the state it moves from. */
export const D1PaymentRequests = Layer.effect(
  PaymentRequests,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const find = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: PaymentRecord,
      execute: (id) => sql`
        SELECT id, job, payer, receiver, payment_hash AS paymentHash, from_block AS fromBlock, state,
          transaction_hash AS transactionHash
        FROM payment_requests WHERE id = ${id}`,
    })
    const lookup = (id: string) => find(id).pipe(Effect.mapError(failed('payment_requests')))
    return PaymentRequests.of({
      open: Effect.fn('Sidequest.Settlement.openRequest')(function* (record) {
        yield* sql`
          INSERT INTO payment_requests (id, job, payer, receiver, payment_hash, from_block, state, transaction_hash)
          VALUES (${record.id}, ${record.job}, ${record.payer}, ${record.receiver}, ${record.paymentHash},
            ${record.fromBlock}, 'begun', NULL)
          ON CONFLICT (id) DO UPDATE SET
            job = excluded.job, payer = excluded.payer, receiver = excluded.receiver,
            payment_hash = excluded.payment_hash, from_block = excluded.from_block, state = 'begun',
            transaction_hash = NULL
          WHERE payment_requests.state = 'cancelled'`.pipe(Effect.mapError(failed('payment_requests')))
        const stored = yield* lookup(record.id)
        return Option.getOrElse(stored, () => record)
      }),
      find: lookup,
      submitted: (id, transactionHash) =>
        sql`UPDATE payment_requests SET state = 'submitted', transaction_hash = ${transactionHash}
          WHERE id = ${id} AND state = 'begun'`.pipe(Effect.asVoid, Effect.mapError(failed('payment_requests'))),
      cancelled: (id) =>
        sql`UPDATE payment_requests SET state = 'cancelled' WHERE id = ${id} AND state = 'begun'`.pipe(
          Effect.asVoid,
          Effect.mapError(failed('payment_requests')),
        ),
    })
  }),
)

/**
 * `relayer_intents`: reserving inserts the intent with the signer's next unused nonce in one statement, so two
 * reservations never take the same one (and `UNIQUE (signer, nonce)` would refuse it if they tried).
 */
export const D1RelayerIntents = Layer.effect(
  RelayerIntents,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const find = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: RelayIntent,
      execute: (id) => sql`
        SELECT id, signer, nonce, target AS "to", data, signed_transaction AS signedTransaction,
          transaction_hash AS transactionHash
        FROM relayer_intents WHERE id = ${id}`,
    })
    const lookup = (id: string) => find(id).pipe(Effect.mapError(failed('relayer_intents')))
    return RelayerIntents.of({
      reserve: Effect.fn('Sidequest.Settlement.reserveIntent')(function* (reservation) {
        yield* sql`
          INSERT INTO relayer_intents (id, signer, nonce, target, data)
          SELECT ${reservation.id}, ${reservation.signer},
            MAX(${reservation.minimumNonce}, COALESCE((SELECT MAX(nonce) + 1 FROM relayer_intents
              WHERE signer = ${reservation.signer}), 0)),
            ${reservation.to}, ${reservation.data}
          WHERE NOT EXISTS (SELECT 1 FROM relayer_intents WHERE id = ${reservation.id})`.pipe(
          Effect.mapError(failed('relayer_intents')),
        )
        const stored = yield* lookup(reservation.id)
        if (Option.isNone(stored)) return yield* new SettlementStoreError({ store: 'relayer_intents' })
        return stored.value
      }),
      sign: (id, signedTransaction, transactionHash) =>
        sql`UPDATE relayer_intents SET signed_transaction = ${signedTransaction}, transaction_hash = ${transactionHash}
          WHERE id = ${id}`.pipe(Effect.asVoid, Effect.mapError(failed('relayer_intents'))),
      find: lookup,
    })
  }),
)

const CursorRow = Schema.Struct({ scannedTo: Schema.String, logs: Schema.fromJsonString(Cursor.fields.logs) })

/** `reader_cursors`: one row per payment, replaced as the scan moves on. */
export const D1ReaderCursors = Layer.effect(
  ReaderCursors,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const find = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: CursorRow,
      execute: (hash) => sql`SELECT scanned_to AS scannedTo, logs FROM reader_cursors WHERE payment_hash = ${hash}`,
    })
    return ReaderCursors.of({
      load: (hash) => find(hash).pipe(Effect.mapError(failed('reader_cursors'))),
      save: (hash, cursor) =>
        sql`
          INSERT INTO reader_cursors (payment_hash, scanned_to, logs)
          VALUES (${hash}, ${cursor.scannedTo}, ${JSON.stringify(cursor.logs)})
          ON CONFLICT (payment_hash) DO UPDATE SET scanned_to = excluded.scanned_to, logs = excluded.logs`.pipe(
          Effect.asVoid,
          Effect.mapError(failed('reader_cursors')),
        ),
    })
  }),
)

/** Settlement's three D1 stores; they need the database's `SqlClient`. */
export const D1SettlementStores = Layer.mergeAll(D1PaymentRequests, D1RelayerIntents, D1ReaderCursors)
