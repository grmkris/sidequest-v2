import {
  IntentRecord,
  type RelayIntent,
  RelayerIntents,
  RelayTransaction,
  SettlementStoreError,
} from '@sidequest/settlement/RelayerIntents'
import { Effect, Layer, Option, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

/** A statement on `relayer_intents` failed: settlement treats it like an unreachable chain, and tries again later. */
const store = () => new SettlementStoreError({ store: 'relayer_intents' })

const IntentRow = IntentRecord
const TransactionRow = Schema.Struct({ ...RelayTransaction.fields, intent: Schema.String })

/** The relayer's reads: an intent by id, a signer's open intents, and their transactions at the nonce each holds. */
const relayerReads = (sql: SqlClient.SqlClient) => {
  const columns = sql`id, signer, nonce, target AS "to", data, state, outcome_hash AS outcome, reason`
  const byId = SqlSchema.findAll({
    Request: Schema.String,
    Result: IntentRow,
    execute: (id) => sql`SELECT ${columns} FROM relayer_intents WHERE id = ${id}`,
  })
  const openOf = SqlSchema.findAll({
    Request: Schema.String,
    Result: IntentRow,
    execute: (signer) =>
      sql`SELECT ${columns} FROM relayer_intents WHERE signer = ${signer} AND state = 'open' ORDER BY nonce`,
  })
  const transactionsOf = SqlSchema.findAll({
    Request: Schema.Array(Schema.String),
    Result: TransactionRow,
    execute: (ids) => sql`
    SELECT t.hash, t.intent, t.sequence, t.kind, t.raw, t.max_fee_per_gas AS maxFeePerGas,
      t.max_priority_fee_per_gas AS maxPriorityFeePerGas, t.signed_at AS signedAt, t.reason, t.refused
    FROM relayer_transactions t JOIN relayer_intents i ON i.id = t.intent AND i.nonce = t.nonce
    WHERE ${sql.in('t.intent', ids)}
    ORDER BY t.sequence`,
  })
  /** Intents with their transactions at the nonce each holds now. */
  const withTransactions = Effect.fnUntraced(function* (rows: ReadonlyArray<typeof IntentRow.Type>) {
    if (rows.length === 0) return []
    const transactions = yield* transactionsOf(rows.map(({ id }) => id))
    return rows.map((row): RelayIntent => ({
      ...row,
      transactions: transactions
        .filter(({ intent }) => intent === row.id)
        .map((transaction) => ({
          hash: transaction.hash,
          sequence: transaction.sequence,
          kind: transaction.kind,
          raw: transaction.raw,
          maxFeePerGas: transaction.maxFeePerGas,
          maxPriorityFeePerGas: transaction.maxPriorityFeePerGas,
          signedAt: transaction.signedAt,
          reason: transaction.reason,
          refused: transaction.refused,
        })),
    }))
  })
  return { byId, openOf, withTransactions }
}

/**
 * `relayer_intents` and `relayer_transactions`. Each write is one statement that guards the state it moves from:
 * reserving inserts the intent with the signer's next unused nonce (and `UNIQUE (signer, nonce)` would refuse a second
 * taker); recording inserts a transaction at the next `sequence` of an open intent's nonce, only while it holds exactly
 * that many there (and `UNIQUE (intent, nonce, sequence)` turns the slower of two relays away); closing and reopening
 * move an intent only from the state they expect.
 */
export const D1RelayerIntents = Layer.effect(
  RelayerIntents,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const { byId, openOf, withTransactions } = relayerReads(sql)
    const lookup = (id: string) =>
      byId(id).pipe(
        Effect.flatMap(withTransactions),
        Effect.map((found) => Option.fromNullishOr(found[0])),
        Effect.mapError(store),
      )
    const stored = (id: string) =>
      Effect.flatMap(lookup(id), (found) =>
        Option.match(found, {
          onNone: () => Effect.fail(new SettlementStoreError({ store: 'relayer_intents' })),
          onSome: Effect.succeed,
        }),
      )
    /** The signer's next unused nonce, at least `minimum`: an intent only ever moves above every other. */
    const nextNonce = (signer: string, minimum: number) =>
      sql`MAX(${minimum}, COALESCE((SELECT MAX(nonce) + 1 FROM relayer_intents WHERE signer = ${signer}), 0))`
    return RelayerIntents.of({
      reserve: Effect.fn('Sidequest.Settlement.reserveIntent')(function* (reservation) {
        yield* sql`
          INSERT INTO relayer_intents (id, signer, nonce, target, data)
          SELECT ${reservation.id}, ${reservation.signer}, ${nextNonce(reservation.signer, reservation.minimumNonce)},
            ${reservation.to}, ${reservation.data}
          WHERE NOT EXISTS (SELECT 1 FROM relayer_intents WHERE id = ${reservation.id})`.pipe(Effect.mapError(store))
        return yield* stored(reservation.id)
      }),
      record: Effect.fn('Sidequest.Settlement.recordTransaction')(function* (id, nonce, transaction) {
        yield* sql`
          INSERT INTO relayer_transactions (hash, intent, nonce, sequence, kind, raw, max_fee_per_gas,
            max_priority_fee_per_gas, signed_at, reason, refused)
          SELECT ${transaction.hash}, ${id}, ${nonce}, ${transaction.sequence}, ${transaction.kind}, ${transaction.raw},
            ${transaction.maxFeePerGas}, ${transaction.maxPriorityFeePerGas}, ${transaction.signedAt},
            ${transaction.reason}, ${transaction.refused}
          WHERE EXISTS (SELECT 1 FROM relayer_intents WHERE id = ${id} AND nonce = ${nonce} AND state = 'open')
            AND (SELECT COUNT(*) FROM relayer_transactions WHERE intent = ${id} AND nonce = ${nonce})
              = ${transaction.sequence}
          ON CONFLICT DO NOTHING`.pipe(Effect.mapError(store))
        return yield* stored(id)
      }),
      refused: (hash, reason) =>
        sql`UPDATE relayer_transactions SET refused = ${reason} WHERE hash = ${hash}`.pipe(
          Effect.asVoid,
          Effect.mapError(store),
        ),
      close: (id, nonce, closing) =>
        sql`UPDATE relayer_intents SET state = ${closing.state}, outcome_hash = ${closing.outcome},
            reason = ${closing.reason}
          WHERE id = ${id} AND nonce = ${nonce} AND state = 'open'`.pipe(Effect.asVoid, Effect.mapError(store)),
      reopen: Effect.fn('Sidequest.Settlement.reopenIntent')(function* (id, minimumNonce) {
        yield* sql`
          UPDATE relayer_intents SET state = 'open', outcome_hash = NULL, reason = NULL,
            nonce = MAX(${minimumNonce}, (SELECT MAX(nonce) + 1 FROM relayer_intents AS other
              WHERE other.signer = relayer_intents.signer))
          WHERE id = ${id} AND state = 'released'`.pipe(Effect.mapError(store))
        return yield* stored(id)
      }),
      find: lookup,
      open: (signer) => openOf(signer).pipe(Effect.flatMap(withTransactions), Effect.mapError(store)),
    })
  }),
)
