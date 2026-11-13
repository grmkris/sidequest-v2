import { Effect, Option, Schema } from 'effect'
import { isAddress, isHex, type PublicClient } from 'viem'
import { rpcCall } from './ChainRpc.ts'
import type { SettlementChain } from './SettlementChain.ts'

/** A log as the RPC returned it, kept undecoded until it is read as a fact. */
export const RawLog = Schema.Struct({
  address: Schema.String,
  topics: Schema.Array(Schema.String),
  data: Schema.String,
  blockNumber: Schema.String,
  transactionHash: Schema.NullOr(Schema.String),
  logIndex: Schema.NullOr(Schema.Int),
})
export type RawLog = typeof RawLog.Type

/** The widest block range one `eth_getLogs` asks for; public RPCs refuse wider ones. */
export const maxLogRange = 5_000n

/** The newest block at the confirmation depth, and its timestamp: what the poller and the settler may act on. */
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

/** A log's parts as hex, if every one is: an RPC that answers otherwise answered nothing usable. */
export const hexParts = (log: RawLog) => {
  const [signature, ...rest] = log.topics
  if (!isAddress(log.address, { strict: false }) || !isHex(log.data) || signature === undefined || !isHex(signature))
    return Option.none()
  const others = rest.filter((topic) => isHex(topic))
  if (others.length !== rest.length) return Option.none()
  return Option.some({ address: log.address, data: log.data, topics: [signature, ...others] as const })
}
