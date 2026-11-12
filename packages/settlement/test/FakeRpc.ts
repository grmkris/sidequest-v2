import { Schema } from 'effect'
import {
  createPublicClient,
  custom,
  encodeAbiParameters,
  encodeFunctionResult,
  type Hex,
  isHex,
  keccak256,
  numberToHex,
  type PublicClient,
  toEventSelector,
} from 'viem'
import { authCaptureEscrowAbi } from '../src/abi/AuthCaptureEscrow.ts'
import { sidequestOperatorAbi } from '../src/abi/SidequestOperator.ts'
import type { RawLog } from '../src/ReaderCursors.ts'

// A JSON-RPC endpoint in memory for the reader and the relayer: blocks with timestamps and logs, the operator's stored
// status, and a mempool. Tests build its state directly; the code under test reaches it only over EIP-1193.

const Request = Schema.Struct({ method: Schema.String, params: Schema.optional(Schema.Array(Schema.Unknown)) })
const LogFilter = Schema.Struct({
  address: Schema.Array(Schema.String),
  fromBlock: Schema.String,
  toBlock: Schema.String,
  topics: Schema.Tuple([Schema.Null, Schema.String]),
})
const BlockParams = Schema.Tuple([Schema.String, Schema.Boolean])
const HashParams = Schema.Tuple([Schema.String])
const CallParams = Schema.Tuple([Schema.Unknown, Schema.String])

interface EventInput {
  readonly name: string
  readonly type: string
  readonly indexed?: boolean
}
interface AbiItem {
  readonly type: string
  readonly name?: string
  readonly inputs?: ReadonlyArray<EventInput>
}

/** A log's topics and data for `eventName` with `args`, encoded as the contract would emit it (no tuple fields). */
const encodeLog = (abi: ReadonlyArray<AbiItem>, eventName: string, args: Readonly<Record<string, unknown>>) => {
  const inputs = abi.find((item) => item.type === 'event' && item.name === eventName)?.inputs ?? []
  const unindexed = inputs.filter((input) => input.indexed !== true)
  const indexed = inputs.filter((input) => input.indexed === true)
  const signature = toEventSelector(`${eventName}(${inputs.map(({ type }) => type).join(',')})`)
  return {
    topics: [signature, ...indexed.map((input) => encodeAbiParameters([{ type: input.type }], [args[input.name]]))],
    data: encodeAbiParameters(
      unindexed.map(({ type }) => ({ type })),
      unindexed.map((input) => args[input.name]),
    ),
  }
}

export const operatorLog = (eventName: string, args: Readonly<Record<string, unknown>>) =>
  encodeLog(sidequestOperatorAbi, eventName, args)
export const escrowLog = (eventName: string, args: Readonly<Record<string, unknown>>) =>
  encodeLog(authCaptureEscrowAbi, eventName, args)

/** A transaction the fake chain holds: pending until mined, then with a receipt. */
interface Transaction {
  readonly raw: Hex
  readonly mined: boolean
}

export interface FakeRpc {
  readonly client: PublicClient
  /** Every method asked, in order. */
  readonly asked: Array<string>
  /** Head block number; blocks without an entry have no logs and a timestamp of `start + number`. */
  head: bigint
  readonly blocks: Map<bigint, { timestamp: number; logs: Array<RawLog> }>
  /** The operator's stored `Job.status` (0 None … 4 Settled) from each block on. */
  readonly statuses: Map<bigint, number>
  readonly transactions: Map<Hex, Transaction>
  /** The signer's next nonce, as `eth_getTransactionCount` reports it. */
  nonce: number
  /** When set, `eth_estimateGas` reverts with it. */
  revert: string | undefined
  /** Fail the next `eth_sendRawTransaction` after accepting it, as a lost response does. */
  dropNextResponse: boolean
  /** Fail every call with a transport error. */
  down: boolean
  /** Record a log at `block`, from `address`, in transaction `transactionHash` (null as some RPCs answer). */
  readonly emit: (
    block: bigint,
    address: string,
    log: { topics: ReadonlyArray<Hex>; data: Hex },
    transactionHash?: Hex | null,
  ) => void
}

const start = 1_800_000_000
const zeroWord: Hex = `0x${'0'.repeat(64)}`

const blockOf = (rpc: FakeRpc, number: bigint) => ({
  number: numberToHex(number),
  hash: keccak256(numberToHex(number)),
  timestamp: numberToHex(rpc.blocks.get(number)?.timestamp ?? start + Number(number)),
  baseFeePerGas: '0x3b9aca00',
  transactions: [],
})

const logsIn = (rpc: FakeRpc, filter: typeof LogFilter.Type) => {
  const from = BigInt(filter.fromBlock)
  const to = BigInt(filter.toBlock)
  return [...rpc.blocks.entries()]
    .filter(([number]) => number >= from && number <= to && number <= rpc.head)
    .flatMap(([, block]) => block.logs)
    .filter((log) => filter.address.some((address) => address.toLowerCase() === log.address.toLowerCase()))
    .filter((log) => log.topics[1] === filter.topics[1])
}

/** `getJob` at a block: the last status set at or before it. */
const jobAt = (rpc: FakeRpc, tag: string) => {
  const at = tag === 'latest' ? rpc.head : BigInt(tag)
  const set = [...rpc.statuses.entries()].filter(([block]) => block <= at).toSorted(([a], [b]) => Number(a - b))
  return encodeFunctionResult({
    abi: sidequestOperatorAbi,
    functionName: 'getJob',
    result: {
      status: set.at(-1)?.[1] ?? 0,
      outcome: 0,
      deliveryDeadline: 0,
      reviewWindow: 0,
      disputeWindow: 0,
      arbitrationWindow: 0,
      deliveredAt: 0,
      rejectedAt: 0,
      arbitrator: '0x0000000000000000000000000000000000000000',
      termsDigest: zeroWord,
      deliveryHash: zeroWord,
    },
  })
}

const sendRaw = (rpc: FakeRpc, raw: string) => {
  if (!isHex(raw)) throw new Error('A raw transaction is hex')
  const hash = keccak256(raw)
  rpc.transactions.set(hash, { raw, mined: false })
  rpc.nonce += 1
  if (rpc.dropNextResponse) {
    rpc.dropNextResponse = false
    throw new Error('socket hang up')
  }
  return hash
}

/** A transaction by hash, or its receipt once mined; null when the chain does not know it. */
const lookup = (rpc: FakeRpc, hash: string, receipt: boolean) => {
  const transaction = isHex(hash) ? rpc.transactions.get(hash) : undefined
  if (transaction === undefined || (receipt && !transaction.mined)) return null
  return { transactionHash: hash, hash, blockNumber: transaction.mined ? '0x1' : null, status: '0x1', logs: [] }
}

const methods: Readonly<Record<string, (rpc: FakeRpc, params: ReadonlyArray<unknown>) => unknown>> = {
  eth_chainId: () => '0x4cef52',
  eth_blockNumber: (rpc) => numberToHex(rpc.head),
  eth_getBlockByNumber: (rpc, params) => {
    const [tag] = Schema.decodeUnknownSync(BlockParams)(params)
    return blockOf(rpc, tag === 'latest' ? rpc.head : BigInt(tag))
  },
  eth_getLogs: (rpc, params) => logsIn(rpc, Schema.decodeUnknownSync(LogFilter)(params[0])),
  eth_call: (rpc, params) => jobAt(rpc, Schema.decodeUnknownSync(CallParams)(params)[1]),
  eth_estimateGas: (rpc) => {
    if (rpc.revert !== undefined) throw Object.assign(new Error(`execution reverted: ${rpc.revert}`), { code: 3 })
    return '0x30d40'
  },
  eth_getTransactionCount: (rpc) => numberToHex(rpc.nonce),
  eth_maxPriorityFeePerGas: () => '0x3b9aca00',
  eth_sendRawTransaction: (rpc, params) => sendRaw(rpc, Schema.decodeUnknownSync(HashParams)(params)[0]),
  eth_getTransactionReceipt: (rpc, params) => lookup(rpc, Schema.decodeUnknownSync(HashParams)(params)[0], true),
  eth_getTransactionByHash: (rpc, params) => lookup(rpc, Schema.decodeUnknownSync(HashParams)(params)[0], false),
}

export const fakeRpc = (): FakeRpc => {
  const request = async (input: unknown) => {
    const { method, params = [] } = Schema.decodeUnknownSync(Request)(input)
    rpc.asked.push(method)
    if (rpc.down) throw new Error('connect ECONNREFUSED')
    const answer = methods[method]
    if (answer === undefined) throw new Error(`The fake chain does not answer ${method}`)
    return answer(rpc, params)
  }
  const rpc: FakeRpc = {
    client: createPublicClient({ transport: custom({ request }, { retryCount: 0 }) }),
    asked: [],
    head: 0n,
    blocks: new Map(),
    statuses: new Map(),
    transactions: new Map(),
    nonce: 0,
    revert: undefined,
    dropNextResponse: false,
    down: false,
    emit: (block, address, log, transactionHash = keccak256(numberToHex(block * 1000n + BigInt(rpc.asked.length)))) => {
      const entry = rpc.blocks.get(block) ?? { timestamp: start + Number(block), logs: [] }
      entry.logs.push({
        address,
        topics: [...log.topics],
        data: log.data,
        blockNumber: numberToHex(block),
        transactionHash,
        logIndex: entry.logs.length,
      })
      rpc.blocks.set(block, entry)
    },
  }
  return rpc
}
