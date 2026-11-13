import { Effect, Option } from 'effect'
import { type Hex, numberToHex, type PublicClient } from 'viem'
import { rpcCall } from './ChainRpc.ts'
import { type Cursor, type RawLog, ReaderCursors } from './ReaderCursors.ts'
import type { SettlementChain } from './SettlementChain.ts'

/** The widest block range one `eth_getLogs` asks for; public RPCs refuse wider ones. */
export const maxLogRange = 5_000n

/** The newest block at the confirmation depth, and its timestamp: what the reader may report on. */
export const confirmedHead = Effect.fnUntraced(function* (rpc: PublicClient, chain: SettlementChain) {
  const head = yield* rpcCall('eth_blockNumber', () => rpc.getBlockNumber({ cacheTime: 0 }))
  const depth = BigInt(Math.max(chain.confirmations, 1) - 1)
  const safe = head >= depth ? head - depth : -1n
  if (safe < 0n) return { head, safe, timestamp: 0 }
  const block = yield* rpcCall('eth_getBlockByNumber', () => rpc.getBlock({ blockNumber: safe }))
  return { head, safe, timestamp: Number(block.timestamp) }
})

/** A log as the RPC answered it, kept only once it is in a block. */
export const toRaw = (log: {
  readonly address: string
  readonly topics: ReadonlyArray<string | null>
  readonly data: string
  readonly blockNumber: string | null
  readonly transactionHash: string | null
  readonly logIndex: string | null
}): Option.Option<RawLog> =>
  log.blockNumber === null
    ? Option.none()
    : Option.some({
        address: log.address,
        topics: log.topics.filter((topic): topic is string => topic !== null),
        data: log.data,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex === null ? null : Number(log.logIndex),
      })

const logsBetween = (rpc: PublicClient, chain: SettlementChain, paymentHash: Hex, from: bigint, to: bigint) =>
  rpcCall('eth_getLogs', () =>
    rpc.request({
      method: 'eth_getLogs',
      params: [
        {
          address: [chain.operator, chain.escrow],
          fromBlock: numberToHex(from),
          toBlock: numberToHex(to),
          topics: [null, paymentHash],
        },
      ],
    }),
  ).pipe(Effect.map((logs) => logs.flatMap((log) => Option.toArray(toRaw(log)))))

/**
 * Every log of the operator and the escrow about `paymentHash` from `fromBlock` up to the confirmed block `safe`:
 * those found before (the payment's cursor) plus a scan of the blocks since, in ranges an RPC accepts. Only confirmed
 * blocks are scanned and stored, so a reorganisation within the confirmation depth never reaches the result.
 */
export const confirmedLogs = Effect.fnUntraced(function* (
  rpc: PublicClient,
  chain: SettlementChain,
  paymentHash: Hex,
  fromBlock: bigint,
  safe: bigint,
) {
  const cursors = yield* ReaderCursors
  const stored = yield* cursors.load(paymentHash)
  const start = Option.match(stored, { onNone: () => fromBlock, onSome: ({ scannedTo }) => BigInt(scannedTo) + 1n })
  let cursor: Cursor = Option.getOrElse(stored, () => ({ scannedTo: String(fromBlock - 1n), logs: [] }))
  for (let from = start; from <= safe; from += maxLogRange) {
    const to = from + maxLogRange - 1n < safe ? from + maxLogRange - 1n : safe
    const found = yield* logsBetween(rpc, chain, paymentHash, from, to)
    cursor = { scannedTo: String(to), logs: [...cursor.logs, ...found] }
    yield* cursors.save(paymentHash, cursor)
  }
  return cursor.logs
})
