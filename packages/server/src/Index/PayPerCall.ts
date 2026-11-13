import { ListingReceipt, maxListingReceipts, type Unavailable } from '@sidequest/protocol'
import { Context, Effect, Layer, Option, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'
import { stored } from '@sidequest/serving/Stored'
import type { ListingRow, ReceiptRow } from './Derived.ts'

// The x402 rail in the index (ADR-0006): pay-per-call listing versions and buyers' receipts, derived from events, and
// the chain's facts about the transactions receipts name, which the chain log poller records. Whether a receipt is
// verified is never stored: every read decides it from those rows, so the answer is the same whatever order the
// events and the facts arrived in, and a rebuild from events and the chain makes it again.

/** uint256's width in decimal digits: amounts padded to it compare in SQLite as the integers they spell. */
const amountWidth = 78

export const padded = (amount: string) => amount.padStart(amountWidth, '0')
const unpadded = (amount: string) => amount.replace(/^0+(?=\d)/u, '')

/** Stores a pay-per-call listing version, once; an escrow listing stores nothing here. */
export const putListingVersion = (sql: SqlClient.SqlClient, row: ListingRow) =>
  row.x402 === null || row.price === null
    ? Effect.void
    : sql`
        INSERT INTO x402_listing_versions (event_id, pubkey, d, resource, pay_to, amount, asset, network)
        VALUES (${row.eventId}, ${row.pubkey}, ${row.slug}, ${row.x402.resource}, ${row.x402.payTo},
          ${padded(row.price.amount)}, ${row.price.asset.toLowerCase()}, ${row.network})
        ON CONFLICT (event_id) DO NOTHING`.pipe(Effect.asVoid)

/** Stores a receipt, once. */
export const putReceipt = (sql: SqlClient.SqlClient, { content, ...row }: ReceiptRow) => {
  const [, seller = '', slug = ''] = content.listing.split(':')
  const asset = content.asset.toLowerCase()
  return sql`
    INSERT INTO x402_receipts (event_id, author, grant_id, created_at, listing_pubkey, listing_d, version, payer, amount,
      asset, network, tx_hash)
    VALUES (${row.eventId}, ${row.pubkey}, ${row.grant}, ${row.createdAt}, ${seller}, ${slug}, ${content.version},
      ${content.payer}, ${padded(content.amount)}, ${asset}, ${asset.slice(0, asset.indexOf('/'))},
      ${content.transaction})
    ON CONFLICT (event_id) DO NOTHING`
}

/**
 * Whether the receipt `r` is verified, as SQL: the confirmed transaction it names holds a transfer of exactly its
 * amount of its asset from its payer to the `payTo` of the listing version it names, that amount is at least the
 * version's price, and the payer's wallet is currently linked (its winning verified link) to the receipt's author, or
 * to the operator of the grant the author's key signed it under, if that grant was the operator's to this key, held
 * the receipt's time in its window, has the `accept` scope (the buyer side's) and is not revoked by its operator.
 */
export const receiptVerified = (sql: SqlClient.SqlClient) => sql`(
  EXISTS (
    SELECT 1 FROM x402_listing_versions AS v
    JOIN x402_tx_checks AS c ON c.network = r.network AND c.tx_hash = r.tx_hash AND c.state = 'confirmed'
    JOIN x402_transfers AS t ON t.network = r.network AND t.tx_hash = r.tx_hash
    WHERE v.event_id = r.version AND v.pubkey = r.listing_pubkey AND v.d = r.listing_d AND v.asset = r.asset
      AND r.amount >= v.amount AND t.asset = r.asset AND t.from_account = r.payer AND t.to_account = v.pay_to
      AND t.value = r.amount
  ) AND (
    SELECT link.pubkey FROM wallet_links AS link
    WHERE link.account = r.payer AND link.verification = 'verified'
    ORDER BY link.issued_at DESC, link.event_id LIMIT 1
  ) IN (r.author, (
    SELECT g.operator FROM agent_grants AS g
    WHERE g.event_id = r.grant_id AND g.agent = r.author AND g.not_before <= r.created_at
      AND r.created_at < g.expires_at
      AND EXISTS (SELECT 1 FROM json_each(g.scopes) WHERE json_each.value = 'accept')
      AND NOT EXISTS (SELECT 1 FROM grant_revocations AS rv WHERE rv.grant_id = g.event_id AND rv.pubkey = g.operator)
  ))
)`

/** A transaction a receipt names that the chain has not answered for yet. */
export interface DueCheck {
  readonly network: string
  readonly txHash: string
}

/** An ERC-20 transfer in a confirmed transaction: the token as CAIP-19, accounts as CAIP-10, all lowercase. */
export interface TransferFact {
  readonly logIndex: number
  readonly asset: string
  readonly from: string
  readonly to: string
  readonly value: string
}

/** What the chain said of a transaction, at the confirmation depth. */
export type TxOutcome =
  | { readonly state: 'pending' }
  | { readonly state: 'reverted'; readonly block: number }
  | { readonly state: 'confirmed'; readonly block: number; readonly transfers: ReadonlyArray<TransferFact> }

/** How many times the poller asks after a transaction before it gives up: once a minute for an hour. */
export const receiptCheckLimits = { attempts: 60, perRun: 10 } as const

const ReceiptRecord = Schema.Struct({
  event: Schema.String,
  author: Schema.String,
  createdAt: Schema.Int,
  payer: Schema.String,
  amount: Schema.String,
  transaction: Schema.String,
  verified: Schema.Literals([0, 1]),
})
const asReceipt = Schema.decodeUnknownOption(ListingReceipt)

/** The x402 rail's rows: receipts as the index labels them, and the chain's facts the poller records. */
export class PayPerCall extends Context.Service<
  PayPerCall,
  {
    /** A listing's receipts, newest first, at most `maxListingReceipts`, each labelled verified or not. */
    readonly receipts: (pubkey: string, slug: string) => Effect.Effect<ReadonlyArray<ListingReceipt>, Unavailable>
    /** Transactions on `network` that receipts name and the chain has not answered for, at most `limit`. */
    readonly due: (network: string, limit: number) => Effect.Effect<ReadonlyArray<DueCheck>, Unavailable>
    /** Records what the chain said: final outcomes once, a pending one as one more attempt. */
    readonly record: (check: DueCheck, outcome: TxOutcome) => Effect.Effect<void, Unavailable>
  }
>()('Sidequest/Index/PayPerCall') {
  /** Over the D1 tables; needs the database's `SqlClient`. */
  static readonly layer = Layer.effect(
    PayPerCall,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const receipts = SqlSchema.findAll({
        Request: Schema.Struct({ pubkey: Schema.String, slug: Schema.String }),
        Result: ReceiptRecord,
        execute: ({ pubkey, slug }) => sql`
          SELECT r.event_id AS event, r.author, r.created_at AS createdAt, r.payer, r.amount,
            r.tx_hash AS "transaction", CASE WHEN ${receiptVerified(sql)} THEN 1 ELSE 0 END AS verified
          FROM x402_receipts AS r WHERE r.listing_pubkey = ${pubkey} AND r.listing_d = ${slug}
          ORDER BY r.created_at DESC, r.event_id LIMIT ${maxListingReceipts}`,
      })
      const due = SqlSchema.findAll({
        Request: Schema.Struct({ network: Schema.String, limit: Schema.Int }),
        Result: Schema.Struct({ network: Schema.String, txHash: Schema.String }),
        execute: ({ network, limit }) => sql`
          SELECT DISTINCT r.network, r.tx_hash AS txHash FROM x402_receipts AS r
          LEFT JOIN x402_tx_checks AS c ON c.network = r.network AND c.tx_hash = r.tx_hash
          WHERE r.network = ${network}
            AND (c.state IS NULL OR (c.state = 'pending' AND c.attempts < ${receiptCheckLimits.attempts}))
          ORDER BY r.tx_hash LIMIT ${limit}`,
      })
      const transfer = (check: DueCheck, fact: TransferFact) => sql`
        INSERT INTO x402_transfers (network, tx_hash, log_index, asset, from_account, to_account, value)
        VALUES (${check.network}, ${check.txHash}, ${fact.logIndex}, ${fact.asset}, ${fact.from}, ${fact.to},
          ${padded(fact.value)})
        ON CONFLICT (network, tx_hash, log_index) DO NOTHING`
      // A final state is written after its transfers, so a run cut short leaves the check pending and is redone.
      const settle = (check: DueCheck, state: 'confirmed' | 'reverted', block: number) => sql`
        INSERT INTO x402_tx_checks (network, tx_hash, state, attempts, block)
        VALUES (${check.network}, ${check.txHash}, ${state}, 1, ${block})
        ON CONFLICT (network, tx_hash) DO UPDATE SET state = excluded.state, block = excluded.block,
          attempts = x402_tx_checks.attempts + 1
        WHERE x402_tx_checks.state = 'pending'`
      const pending = (check: DueCheck) => sql`
        INSERT INTO x402_tx_checks (network, tx_hash, state, attempts, block)
        VALUES (${check.network}, ${check.txHash}, 'pending', 1, NULL)
        ON CONFLICT (network, tx_hash) DO UPDATE SET attempts = x402_tx_checks.attempts + 1
        WHERE x402_tx_checks.state = 'pending'`
      return PayPerCall.of({
        receipts: Effect.fn('Sidequest.Index.listingReceipts')(function* (pubkey, slug) {
          const rows = yield* stored(receipts({ pubkey, slug }))
          return rows.flatMap((row) =>
            Option.toArray(asReceipt({ ...row, amount: unpadded(row.amount), verified: row.verified === 1 })),
          )
        }),
        due: Effect.fn('Sidequest.Index.dueReceiptChecks')(function* (network, limit) {
          return yield* stored(due({ network, limit }))
        }),
        record: Effect.fn('Sidequest.Index.recordReceiptCheck')(function* (check, outcome) {
          if (outcome.state === 'pending') {
            yield* stored(pending(check))
            return
          }
          if (outcome.state === 'confirmed')
            yield* stored(Effect.forEach(outcome.transfers, (fact) => transfer(check, fact), { discard: true }))
          yield* stored(settle(check, outcome.state, outcome.block))
        }),
      })
    }),
  )
}
