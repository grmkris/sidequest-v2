import { RelayedCall, type Unavailable } from '@sidequest/protocol'
import { type ChainUnavailable, rpcCall } from '@sidequest/settlement/ChainRpc'
import { confirmedHead } from '@sidequest/settlement/LogScan'
import { Effect, Option } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'
import { ArcRpc } from '../Settlement/ArcRpc.ts'
import { Settlement, type SettlementService } from '../Settlement/Settlement.ts'
import { stored } from '@sidequest/serving/Stored'

/**
 * What the escrow steps and the settler need of the chain: the settlement chain, its time (the newest confirmed block's
 * timestamp, which every deadline is judged against, never the server's clock), the relayer and the interim
 * arbitrator's key.
 */
export interface EscrowChain extends SettlementService {
  readonly chainTime: Effect.Effect<number, ChainUnavailable>
  /** The relayer's balance in the chain's native unit (wei), which pays every relayed call's gas. */
  readonly relayerBalance: Effect.Effect<bigint, ChainUnavailable>
}

/** The chain under the configured settlement, or none on a stage without it. Needs `Settlement` and `ArcRpc`. */
export const escrowChain = Effect.gen(function* () {
  const settlement = yield* Settlement
  const rpc = yield* ArcRpc
  return Option.map(settlement, (service): EscrowChain => ({
    ...service,
    chainTime: Effect.map(confirmedHead(rpc, service.chain), ({ timestamp }) => timestamp),
    relayerBalance: rpcCall('eth_getBalance', () => rpc.getBalance({ address: service.relayer })),
  }))
})

/**
 * The payment hash in an intent's id: every id Sidequest relays under is `<step>:<payment hash>[:…]`, the hash a
 * lowercase `0x` and 64 hex digits, and no step holds a `:`. The expression is exactly the one migration 0015 indexes
 * (`relayer_intents_by_payment`), so a lookup by payment is an index search, not a scan of every intent.
 */
export const intentPaymentHash = (sql: SqlClient.SqlClient) => sql.literal("substr(i.id, instr(i.id, ':') + 1, 66)")

/** The most relayed calls listed for one payment. */
const relayedLimit = 20

/**
 * The relayer's intents for one payment: every intent id Sidequest relays names the payment's hash
 * (`<step>:<payment hash>[:…]`), so its calls are the intents whose id holds the hash, oldest nonce first, each with the
 * transaction that used its nonce, or while open the latest call it signed.
 */
export const relayedReads = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const read = SqlSchema.findAll({
    Request: RelayedCall.fields.intent,
    Result: RelayedCall,
    execute: (paymentHash) => sql`
      SELECT i.id AS intent, i.state, i.reason,
        COALESCE(i.outcome_hash, (
          SELECT t.hash FROM relayer_transactions AS t
          WHERE t.intent = i.id AND t.nonce = i.nonce AND t.kind = 'call' ORDER BY t.sequence DESC LIMIT 1
        )) AS transactionHash
      FROM relayer_intents AS i WHERE ${intentPaymentHash(sql)} = ${paymentHash}
      ORDER BY i.nonce, i.id LIMIT ${relayedLimit}`,
  })
  return (paymentHash: string): Effect.Effect<ReadonlyArray<RelayedCall>, Unavailable> =>
    stored(read(paymentHash)).pipe(Effect.withSpan('Sidequest.Escrow.relayed'))
})
