import { RelayedCall, type Unavailable } from '@sidequest/protocol'
import type { ChainUnavailable } from '@sidequest/settlement/ChainRpc'
import { confirmedHead } from '@sidequest/settlement/LogScan'
import type { OperatorCall } from '@sidequest/settlement/OperatorCall'
import type { SettlementStoreError } from '@sidequest/settlement/ReaderCursors'
import type { RelayError, Relayed } from '@sidequest/settlement/Relayer'
import type { SettlementChain } from '@sidequest/settlement/SettlementChain'
import { Effect, Option } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'
import type { Hex } from 'viem'
import { Escrow } from '../Settlement/Escrow.ts'
import { ArcRpc } from '../SignIn/ArcRpc.ts'
import { stored } from '../SignIn/Stored.ts'

/**
 * What Nostr-native settlement needs of the chain: the settlement chain, its time (the newest confirmed block's
 * timestamp, which every deadline is judged against, never the server's clock), phase 1's relayer (one key, one nonce
 * sequence, one store of intents, so the two paths never race for a nonce), and the interim arbitrator's key.
 */
export interface NativeChain {
  readonly chain: SettlementChain
  readonly chainTime: Effect.Effect<number, ChainUnavailable>
  readonly relay: (id: string, call: OperatorCall) => Effect.Effect<Relayed, RelayError>
  readonly repair: Effect.Effect<void, SettlementStoreError | ChainUnavailable>
  readonly signRuling: Option.Option<(paymentHash: Hex, workerShareBps: number) => Effect.Effect<Hex>>
}

/** The chain over the configured escrow, or none on a stage without settlement. Needs `Escrow` and `ArcRpc`. */
export const nativeChain = Effect.gen(function* () {
  const escrow = yield* Escrow
  const rpc = yield* ArcRpc
  return Option.map(escrow, (service): NativeChain => ({
    chain: service.chain,
    chainTime: Effect.map(confirmedHead(rpc, service.chain), ({ timestamp }) => timestamp),
    relay: service.relay,
    repair: service.repair,
    signRuling: service.signRuling,
  }))
})

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
      FROM relayer_intents AS i WHERE instr(i.id, ${paymentHash}) > 0
      ORDER BY i.nonce, i.id LIMIT ${relayedLimit}`,
  })
  return (paymentHash: string): Effect.Effect<ReadonlyArray<RelayedCall>, Unavailable> =>
    stored(read(paymentHash)).pipe(Effect.withSpan('Sidequest.Native.relayed'))
})
