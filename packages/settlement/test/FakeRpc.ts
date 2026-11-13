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
  parseTransaction,
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
  // One payment's logs (`[null, paymentHash]`, the chain reader), or any of some events' (`[[selector, …]]`, the job
  // log scan).
  topics: Schema.Union([Schema.Tuple([Schema.Null, Schema.String]), Schema.Tuple([Schema.Array(Schema.String)])]),
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

/** A transaction the fake chain holds: pending until mined, then with a receipt (whose status is `reverted` or not). */
export interface Transaction {
  readonly raw: Hex
  /** The recipient, lowercase: the operator for a call, the relayer itself for a release. */
  readonly to: string
  readonly nonce: number
  readonly maxFeePerGas: bigint
  readonly maxPriorityFeePerGas: bigint
  readonly mined: boolean
  readonly reverted: boolean
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
  /** The signer's next nonce counting pending transactions, as `eth_getTransactionCount` at `pending` reports it. */
  nonce: number
  /** Nonces used by transactions this chain never saw (the key signing elsewhere): `latest` counts at least this. */
  usedElsewhere: number
  /** When set, `eth_estimateGas` reverts with it. */
  revert: string | undefined
  /** Fail the next `eth_sendRawTransaction` after accepting it, as a lost response does. */
  dropNextResponse: boolean
  /** Fail the next `eth_sendRawTransaction` before it arrives, as a broken connection does. */
  failNextSend: boolean
  /** When it answers a message for a transaction, the node refuses that transaction with it (a JSON-RPC error). */
  refuse: (transaction: Transaction) => string | undefined
  /** Mine every transaction as it arrives, as Anvil does. */
  autoMine: boolean
  /** Mine a pending transaction (reverted or not); the other transactions at its nonce leave the mempool. */
  readonly mine: (hash: Hex, options?: { readonly reverted?: boolean }) => void
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
    .filter((log) => {
      const [first, second] = filter.topics
      return first === null ? log.topics[1] === second : first.includes(log.topics[0] ?? '')
    })
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

/** The signer's mined nonce count: one above the highest mined nonce, or what was used elsewhere. */
const latestNonce = (rpc: FakeRpc) =>
  [...rpc.transactions.values()]
    .filter(({ mined }) => mined)
    .reduce((next, { nonce }) => Math.max(next, nonce + 1), rpc.usedElsewhere)

/** A refusal as a node answers it: a JSON-RPC error, which viem reports with its code. */
const refusal = (message: string) => Object.assign(new Error(message), { code: -32000 })

/** Whether `transaction` may replace `pending` at its nonce: both fees at least a tenth higher, as geth requires. */
const outbids = (transaction: Transaction, pending: Transaction) =>
  transaction.maxFeePerGas * 10n >= pending.maxFeePerGas * 11n &&
  transaction.maxPriorityFeePerGas * 10n >= pending.maxPriorityFeePerGas * 11n

const sendRaw = (rpc: FakeRpc, raw: string) => {
  if (!isHex(raw)) throw new Error('A raw transaction is hex')
  if (rpc.failNextSend) {
    rpc.failNextSend = false
    throw new Error('socket hang up')
  }
  const parsed = parseTransaction(raw)
  const transaction: Transaction = {
    raw,
    to: (parsed.to ?? '').toLowerCase(),
    nonce: parsed.nonce ?? 0,
    maxFeePerGas: parsed.maxFeePerGas ?? 0n,
    maxPriorityFeePerGas: parsed.maxPriorityFeePerGas ?? 0n,
    mined: false,
    reverted: false,
  }
  const hash = keccak256(raw)
  if (rpc.transactions.has(hash)) throw refusal('already known')
  if (transaction.nonce < latestNonce(rpc)) throw refusal('nonce too low')
  const rival = [...rpc.transactions.entries()].find(([, held]) => !held.mined && held.nonce === transaction.nonce)
  if (rival !== undefined && !outbids(transaction, rival[1])) throw refusal('replacement transaction underpriced')
  const refused = rpc.refuse(transaction)
  if (refused !== undefined) throw refusal(refused)
  if (rival !== undefined) rpc.transactions.delete(rival[0])
  rpc.transactions.set(hash, transaction)
  rpc.nonce = Math.max(rpc.nonce, transaction.nonce + 1)
  if (rpc.autoMine) rpc.mine(hash)
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
  return {
    transactionHash: hash,
    hash,
    blockNumber: transaction.mined ? '0x1' : null,
    status: transaction.reverted ? '0x0' : '0x1',
    logs: [],
  }
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
  eth_getTransactionCount: (rpc, params) =>
    numberToHex(params[1] === 'pending' ? Math.max(rpc.nonce, latestNonce(rpc)) : latestNonce(rpc)),
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
    usedElsewhere: 0,
    revert: undefined,
    dropNextResponse: false,
    failNextSend: false,
    refuse: () => undefined,
    autoMine: false,
    down: false,
    mine: (hash, { reverted = false } = {}) => {
      const transaction = rpc.transactions.get(hash)
      if (transaction === undefined || transaction.mined) throw new Error(`No pending transaction ${hash}`)
      for (const [other, held] of rpc.transactions)
        if (other !== hash && !held.mined && held.nonce === transaction.nonce) rpc.transactions.delete(other)
      rpc.transactions.set(hash, { ...transaction, mined: true, reverted })
    },
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
