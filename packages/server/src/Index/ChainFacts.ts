import { ChainFact } from '@sidequest/fold'
import type { Unavailable } from '@sidequest/protocol'
import { Context, Effect, Layer, Match, Option, Predicate, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'
import { stored } from '@sidequest/serving/Stored'

/** One chain fact as the index keeps it: the fact, and the chain (CAIP-2) and transaction its log is in. */
export interface ChainLog {
  readonly chain: string
  readonly transactionHash: string
  readonly fact: ChainFact
}

/**
 * The most facts `forJob` reads for one job: its earliest fundings (the fold uses the earliest and only lists the
 * others), and the facts on the earliest funding's payment (the operator logs each of delivery, rejection and
 * settlement once per payment, so a handful is all there ever is).
 */
export const chainFactLimits = { fundings: 20, paymentFacts: 20 } as const

const FactJson = Schema.fromJsonString(ChainFact)
const encodeFact = Schema.encodeSync(FactJson)
const FactRow = Schema.Struct({ fact: FactJson })

/** The row's `kind`: which of the fold's facts it is. */
const kindOf = (fact: ChainFact) =>
  Match.valueTags(fact, {
    Funded: () => 'Funded',
    Delivered: () => 'Delivered',
    Rejected: () => 'Rejected',
    Settled: () => 'Settled',
    Reclaimed: () => 'Reclaimed',
  })

/**
 * The chain's facts about jobs' escrow payments, read from the operator's and the escrow's logs: one row per log,
 * never updated, so recording is idempotent and the table is the same whatever order logs were recorded in. Fed by
 * the chain log poller, and never rebuilt from `events`: a rebuild re-reads the chain.
 */
export class ChainFacts extends Context.Service<
  ChainFacts,
  {
    /** Records each fact once; a fact recorded before is left as it is. */
    readonly record: (logs: ReadonlyArray<ChainLog>) => Effect.Effect<void, Unavailable>
    /**
     * The facts the fold needs for a job, by the `bytes32 jobId` as the chain has it (64 hex digits): its fundings and
     * the later facts of its earliest funding's payment, bounded by `chainFactLimits`. A phase 1 job's word names no
     * request, so its facts fold to nothing; the two are never bridged.
     */
    readonly forJob: (job: string) => Effect.Effect<ReadonlyArray<ChainFact>, Unavailable>
    /** The last block the poller scanned on `chain`, if it has scanned any. */
    readonly scannedTo: (chain: string) => Effect.Effect<Option.Option<number>, Unavailable>
    /** Moves `chain`'s cursor forward to `block`; never back. */
    readonly advance: (chain: string, block: number) => Effect.Effect<void, Unavailable>
  }
>()('Sidequest/Index/ChainFacts') {
  /** Over the D1 tables; needs the database's `SqlClient`. */
  static readonly layer = Layer.effect(
    ChainFacts,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const insert = ({ chain, transactionHash, fact }: ChainLog) => sql`
        INSERT INTO chain_facts (chain, tx_hash, log_index, block, kind, payment_hash, job, fact)
        VALUES (${chain}, ${transactionHash}, ${fact.at.logIndex}, ${fact.at.block}, ${kindOf(fact)}, ${fact.paymentHash},
          ${Predicate.isTagged(fact, 'Funded') ? fact.job : null}, ${encodeFact(fact)})
        ON CONFLICT (chain, tx_hash, log_index) DO NOTHING`
      const fundings = SqlSchema.findAll({
        Request: Schema.String,
        Result: FactRow,
        execute: (job) => sql`
          SELECT fact FROM chain_facts WHERE job = ${job} AND kind = 'Funded'
          ORDER BY block, log_index, chain, tx_hash LIMIT ${chainFactLimits.fundings}`,
      })
      const ofPayment = SqlSchema.findAll({
        Request: Schema.String,
        Result: FactRow,
        execute: (paymentHash) => sql`
          SELECT fact FROM chain_facts WHERE payment_hash = ${paymentHash} AND kind <> 'Funded'
          ORDER BY block, log_index, chain, tx_hash LIMIT ${chainFactLimits.paymentFacts}`,
      })
      const cursor = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: Schema.Struct({ scannedTo: Schema.Int }),
        execute: (chain) => sql`SELECT scanned_to AS scannedTo FROM chain_cursors WHERE chain = ${chain}`,
      })
      return ChainFacts.of({
        record: Effect.fn('Sidequest.Index.recordChainFacts')(function* (logs) {
          yield* stored(Effect.forEach(logs, insert, { discard: true }))
        }),
        forJob: Effect.fn('Sidequest.Index.chainFactsForJob')(function* (job) {
          const funded = (yield* stored(fundings(job))).map(({ fact }) => fact)
          const earliest = funded[0]
          if (earliest === undefined) return []
          const later = yield* stored(ofPayment(earliest.paymentHash))
          return [...funded, ...later.map(({ fact }) => fact)]
        }),
        scannedTo: Effect.fn('Sidequest.Index.chainCursor')(function* (chain) {
          return Option.map(yield* stored(cursor(chain)), ({ scannedTo }) => scannedTo)
        }),
        advance: Effect.fn('Sidequest.Index.advanceChainCursor')(function* (chain, block) {
          yield* stored(sql`
            INSERT INTO chain_cursors (chain, scanned_to) VALUES (${chain}, ${block})
            ON CONFLICT (chain) DO UPDATE SET scanned_to = excluded.scanned_to
            WHERE excluded.scanned_to > chain_cursors.scanned_to`)
        }),
      })
    }),
  )
}
