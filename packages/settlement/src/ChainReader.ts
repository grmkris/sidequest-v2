import type {
  ChainDelivery,
  ChainProblem,
  ChainRejection,
  ChainSettlement,
  EscrowStage,
  EscrowStatus,
  Receipt,
} from '@sidequest/protocol'
import { Effect, Match } from 'effect'
import { isAddressEqual, isAddress, type PublicClient } from 'viem'
import { sidequestOperatorAbi } from './abi/SidequestOperator.ts'
import { ChainRpc, rpcCall } from './ChainRpc.ts'
import type { Expected } from './Expected.ts'
import { confirmedHead, confirmedLogs } from './LogScan.ts'
import type { RawLog } from './ReaderCursors.ts'
import { type LogReading, readLog, type Verified } from './Verify.ts'

const operatorStatuses: ReadonlyArray<EscrowStage> = ['Unfunded', 'Funded', 'Delivered', 'Disputed', 'Settled']

/** What the logs established: the first verified fact of each kind, and every problem. */
interface Facts {
  readonly funding?: Receipt
  readonly delivery?: ChainDelivery
  readonly rejection?: ChainRejection
  readonly settlement?: ChainSettlement
  readonly problems: ReadonlyArray<ChainProblem>
}

const keep = <A>(
  facts: Facts,
  kind: 'funding' | 'delivery' | 'rejection' | 'settlement',
  reading: Verified<A>,
): Facts =>
  Match.valueTags(reading, {
    Problem: ({ problem }): Facts => ({ ...facts, problems: [...facts.problems, problem] }),
    Fact: ({ fact }): Facts => (facts[kind] === undefined ? { ...facts, [kind]: fact } : facts),
  })

const fold = (facts: Facts, reading: LogReading): Facts => {
  switch (reading.kind) {
    case 'funding':
      return keep(facts, 'funding', reading.reading)
    case 'delivery':
      return keep(facts, 'delivery', reading.reading)
    case 'rejection':
      return keep(facts, 'rejection', reading.reading)
    case 'settlement':
      return keep(facts, 'settlement', reading.reading)
    case 'problem':
      return { ...facts, problems: [...facts.problems, reading.problem] }
    case 'ignored':
      return facts
  }
}

/** A later fact counts only after the one it follows: a delivery after funding, a rejection after a delivery. */
const ordered = (facts: Facts): Facts => {
  const funding = facts.funding
  const delivery = funding === undefined ? undefined : facts.delivery
  const rejection = delivery === undefined ? undefined : facts.rejection
  const settlement = funding === undefined ? undefined : facts.settlement
  return {
    problems: facts.problems,
    ...(funding === undefined ? {} : { funding }),
    ...(delivery === undefined ? {} : { delivery }),
    ...(rejection === undefined ? {} : { rejection }),
    ...(settlement === undefined ? {} : { settlement }),
  }
}

const stageOf = (facts: Facts): EscrowStage => {
  if (facts.settlement !== undefined) return 'Settled'
  if (facts.rejection !== undefined) return 'Disputed'
  if (facts.delivery !== undefined) return 'Delivered'
  return facts.funding === undefined ? 'Unfunded' : 'Funded'
}

/** The block timestamp of an escrow log: only a reclaim needs it, the operator logs its own times. */
const blockTimeOf = (rpc: PublicClient, expected: Expected, log: RawLog) =>
  isAddress(log.address, { strict: false }) && isAddressEqual(log.address, expected.chain.escrow)
    ? rpcCall('eth_getBlockByNumber', () => rpc.getBlock({ blockNumber: BigInt(log.blockNumber) })).pipe(
        Effect.map((block) => Number(block.timestamp)),
      )
    : Effect.succeed(0)

/** The operator's stored status at the confirmed block; the events must account for it. */
const statusProblem = Effect.fnUntraced(function* (
  rpc: PublicClient,
  expected: Expected,
  safe: bigint,
  stage: EscrowStage,
) {
  const job = yield* rpcCall('getJob', () =>
    rpc.readContract({
      address: expected.chain.operator,
      abi: sidequestOperatorAbi,
      functionName: 'getJob',
      args: [expected.payment.hash],
      blockNumber: safe,
    }),
  )
  const stored = operatorStatuses[job.status] ?? 'Unfunded'
  // A reclaim settles in the escrow and leaves the operator's job where it was.
  const accounted = stored === stage || (stage === 'Settled' && stored !== 'Unfunded')
  const problem: ChainProblem = {
    event: 'getJob',
    kind: 'inconclusive',
    field: 'status',
    expected: stored,
    observed: stage,
  }
  return accounted ? [] : [problem]
})

/**
 * The independent chain reader: for one job's payment, every operator event (and the escrow's reclaim) at the
 * confirmation depth, each verified field by field against the agreement, and the operator's stored status at that
 * block checked against them. Facts that fail a check, or that do not follow their predecessor, count for nothing and
 * are listed as problems. It writes only its own scan cursor.
 */
export const readEscrow = Effect.fn('Sidequest.Settlement.readEscrow')(function* (expected: Expected) {
  const rpc = yield* ChainRpc
  const { head, safe, timestamp } = yield* confirmedHead(rpc, expected.chain)
  const logs =
    safe < expected.fromBlock
      ? []
      : yield* confirmedLogs(rpc, expected.chain, expected.payment.hash, expected.fromBlock, safe)
  const readings = yield* Effect.forEach(logs, (log) =>
    Effect.map(blockTimeOf(rpc, expected, log), (time) => readLog(expected, log, head, time)),
  )
  const facts = ordered(readings.reduce(fold, { problems: [] }))
  const stage = stageOf(facts)
  const status = safe < 0n ? [] : yield* statusProblem(rpc, expected, safe, stage)
  const observed: EscrowStatus = {
    paymentHash: expected.payment.hash,
    chainTime: timestamp,
    stage,
    funding: facts.funding ?? null,
    delivery: facts.delivery ?? null,
    rejection: facts.rejection ?? null,
    settlement: facts.settlement ?? null,
    problems: [...facts.problems, ...status],
  }
  return observed
})
