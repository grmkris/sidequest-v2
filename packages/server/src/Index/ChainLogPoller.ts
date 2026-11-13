import { ChainFact } from '@sidequest/fold'
import type { Unavailable } from '@sidequest/protocol'
import { type ChainUnavailable, ChainRpc, rpcCall } from '@sidequest/settlement/ChainRpc'
import { jobLogFact, jobLogsBetween, needsBlockTime } from '@sidequest/settlement/JobLogs'
import { confirmedHead, maxLogRange, type RawLog } from '@sidequest/settlement/LogScan'
import type { SettlementChain } from '@sidequest/settlement/SettlementChain'
import { Context, Effect, Layer, Option, Schema } from 'effect'
import type { PublicClient } from 'viem'
import { type ChainLog, ChainFacts } from './ChainFacts.ts'

/**
 * How the poller reads: each pass re-reads `overlap` blocks below its cursor (an RPC node behind a load balancer may
 * answer a range before it has indexed every log in it), and reads at most `rangesPerRun` ranges of `maxLogRange`
 * blocks, so one pass is bounded and a long way behind is caught up over several.
 */
export const chainLogLimits = { overlap: 32n, rangesPerRun: 10n } as const

const asFact = Schema.decodeUnknownOption(ChainFact)

/** Each log's fact with its chain and transaction; a log that is no fact, or not one the fold reads, is skipped. */
const factsOf = (rpc: PublicClient, chain: SettlementChain, logs: ReadonlyArray<RawLog>) =>
  Effect.gen(function* () {
    const times = new Map<string, number>()
    const timeOf = (log: RawLog) =>
      Effect.gen(function* () {
        if (!needsBlockTime(chain, log)) return 0
        const known = times.get(log.blockNumber)
        if (known !== undefined) return known
        const block = yield* rpcCall('eth_getBlockByNumber', () =>
          rpc.getBlock({ blockNumber: BigInt(log.blockNumber) }),
        )
        times.set(log.blockNumber, Number(block.timestamp))
        return Number(block.timestamp)
      })
    const found = yield* Effect.forEach(logs, (log) =>
      Effect.map(timeOf(log), (time) =>
        Option.flatMap(jobLogFact(chain, log, time), ({ transactionHash, ...fact }) =>
          Option.map(asFact(fact), (decoded): ChainLog => ({
            chain: chain.asset.network,
            transactionHash,
            fact: decoded,
          })),
        ),
      ),
    )
    return found.flatMap(Option.toArray)
  })

/**
 * The chain log poller: reads the operator's and the escrow's logs into `chain_facts`, through the settlement chain's
 * RPC. It reads only blocks at the chain's confirmation
 * depth and moves its per-chain cursor only past blocks it has read and recorded, so a pass cut short is redone by the
 * next. A reorganisation deeper than the confirmation depth is not handled: a fact it undid stays recorded (labelling
 * or removing it is later tooling's work).
 */
export class ChainLogPoller extends Context.Service<
  ChainLogPoller,
  { readonly run: Effect.Effect<void, ChainUnavailable | Unavailable> }
>()('Sidequest/Index/ChainLogPoller') {
  /** No settlement chain on this stage: nothing is read and nothing runs. */
  static readonly disabled = Layer.succeed(ChainLogPoller, ChainLogPoller.of({ run: Effect.void }))

  /**
   * Polls `chain`. The first pass starts at `startBlock` (the operator's deployment, to read its history), or without
   * one at the confirmed head. Needs `ChainRpc` and `ChainFacts`.
   */
  static readonly layer = (chain: SettlementChain, startBlock: Option.Option<bigint>) =>
    Layer.effect(
      ChainLogPoller,
      Effect.gen(function* () {
        const rpc = yield* ChainRpc
        const facts = yield* ChainFacts
        const network = chain.asset.network
        const readRange = (from: bigint, to: bigint) =>
          Effect.gen(function* () {
            const logs = yield* jobLogsBetween(rpc, chain, from, to)
            yield* facts.record(yield* factsOf(rpc, chain, logs))
            yield* facts.advance(network, Number(to))
          })
        const run = Effect.gen(function* () {
          const { safe } = yield* confirmedHead(rpc, chain)
          if (safe < 0n) return
          const cursor = yield* facts.scannedTo(network)
          const start = Option.match(cursor, {
            onNone: () => Option.getOrElse(startBlock, () => safe),
            onSome: (scanned) => {
              const from = BigInt(scanned) + 1n - chainLogLimits.overlap
              return from < 0n ? 0n : from
            },
          })
          const last = start + maxLogRange * chainLogLimits.rangesPerRun - 1n
          const end = last < safe ? last : safe
          for (let from = start; from <= end; from += maxLogRange) {
            const to = from + maxLogRange - 1n < end ? from + maxLogRange - 1n : end
            yield* readRange(from, to)
          }
        }).pipe(Effect.withSpan('Sidequest.Index.pollChain', { attributes: { 'sidequest.chain': network } }))
        return ChainLogPoller.of({ run })
      }),
    )
}
