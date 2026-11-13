import { sidequestOperatorAbi } from '@sidequest/settlement/abi/SidequestOperator'
import { type PaymentInfo, paymentInfoHash } from '@sidequest/settlement/Payment'
import { Option, Schema } from 'effect'
import {
  type Address,
  decodeFunctionData,
  getAddress,
  type Hex,
  isAddressEqual,
  isHex,
  keccak256,
  parseTransaction,
} from 'viem'

// The stack's only way to the chain: a JSON-RPC proxy on 127.0.0.1 in front of Anvil (or Arc testnet). It passes every
// request through, records every raw transaction the relayer sends, and can withhold, for one payment, every
// `SidequestOperator` call: the node then refuses them outright, as a node can refuse a transaction for good. That is
// how a rehearsal keeps settlement calls from a job until its escrow expires, and it exercises the relayer's repair of
// the nonces it leaves unused.
// It also counts every request by method, with its failures and latency, for the evidence: what the stack asked of the
// chain, and whether the chain (a public RPC with a rate limit) answered.

const Request = Schema.fromJsonString(
  Schema.Struct({ id: Schema.Unknown, method: Schema.String, params: Schema.optional(Schema.Array(Schema.Unknown)) }),
)

/** A transaction the relayer handed the proxy, and what became of it there. */
export interface Sent {
  readonly hash: Hex
  readonly to: string
  readonly nonce: number
  readonly function: string
  readonly withheld: boolean
  /** When the proxy saw it, Unix milliseconds. */
  readonly at: number
}

/** One JSON-RPC method's requests through the proxy: how many, how many failed, and how long they took. */
export interface MethodCensus {
  readonly requests: number
  /** Answered with an HTTP error, a JSON-RPC error, or not at all. */
  readonly failed: number
  readonly totalMs: number
  readonly maxMs: number
  /** The first few distinct failures, as the node or the transport put them. */
  readonly failures: ReadonlyArray<string>
}

export interface RpcProxy {
  readonly url: string
  /** Every `eth_sendRawTransaction` the proxy saw, in order. */
  readonly sent: Array<Sent>
  /** Every request the proxy passed on, by method. */
  readonly census: Map<string, MethodCensus>
  /** Payment hashes whose operator calls the node refuses. */
  readonly withheld: Set<Hex>
  readonly stop: () => void
}

const Info = Schema.Struct({
  operator: Schema.String,
  payer: Schema.String,
  receiver: Schema.String,
  token: Schema.String,
  maxAmount: Schema.BigInt,
  preApprovalExpiry: Schema.Number,
  authorizationExpiry: Schema.Number,
  refundExpiry: Schema.Number,
  minFeeBps: Schema.Number,
  maxFeeBps: Schema.Number,
  feeReceiver: Schema.String,
  salt: Schema.BigInt,
})

/** The payment an operator call is for: its first argument is always the `PaymentInfo`. */
const paymentOfCall = (data: Hex, chain: { readonly chainId: number; readonly escrow: Address }) => {
  const { functionName, args } = decodeFunctionData({ abi: sidequestOperatorAbi, data })
  const info = Option.getOrUndefined(Schema.decodeUnknownOption(Info)(args?.[0]))
  if (info === undefined) return { functionName, hash: undefined }
  const { operator, payer, receiver, token, feeReceiver } = info
  const addresses = [operator, payer, receiver, token, feeReceiver].map((value) => getAddress(value))
  const [first, second, third, fourth, fifth] = addresses
  if (first === undefined || second === undefined || third === undefined || fourth === undefined || fifth === undefined)
    return { functionName, hash: undefined }
  const typed: PaymentInfo = {
    ...info,
    operator: first,
    payer: second,
    receiver: third,
    token: fourth,
    feeReceiver: fifth,
  }
  return { functionName, hash: paymentInfoHash(typed, chain) }
}

const refusal = (id: unknown, message: string) =>
  Response.json({ jsonrpc: '2.0', id, error: { code: -32003, message } })

const AnswerError = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.Struct({ code: Schema.optional(Schema.Number), message: Schema.optional(Schema.String) }),
  }),
)

/** Why an answer is a failure (an HTTP error, a JSON-RPC error, or none at all), or undefined for a result. */
const failureOf = (answered: { readonly status: number; readonly text: string; readonly cause?: string }) => {
  if (answered.status === 0) return `transport: ${answered.cause ?? 'no answer'}`.slice(0, 160)
  const error = Option.getOrUndefined(Schema.decodeUnknownOption(AnswerError)(answered.text))?.error
  if (error !== undefined) return `${error.code ?? '?'} ${error.message ?? ''}`.slice(0, 160)
  return answered.status >= 400 ? `HTTP ${answered.status}` : undefined
}

const recordedFailures = 5

/** Counts one request of `method` in the census. */
const count = (census: Map<string, MethodCensus>, method: string, ms: number, failure: string | undefined) => {
  const was = census.get(method) ?? { requests: 0, failed: 0, totalMs: 0, maxMs: 0, failures: [] }
  const failures =
    failure === undefined || was.failures.includes(failure) || was.failures.length >= recordedFailures
      ? was.failures
      : [...was.failures, failure]
  census.set(method, {
    requests: was.requests + 1,
    failed: was.failed + (failure === undefined ? 0 : 1),
    totalMs: was.totalMs + ms,
    maxMs: Math.max(was.maxMs, ms),
    failures,
  })
}

/** Start the proxy in front of `upstream`; calls to `operator` for a withheld payment are refused. */
export const startProxy = (
  upstream: string,
  chain: { readonly chainId: number; readonly escrow: Address; readonly operator: Address },
): RpcProxy => {
  const sent: Array<Sent> = []
  const withheld = new Set<Hex>()
  const census = new Map<string, MethodCensus>()
  const inspect = (raw: string): Sent | undefined => {
    if (!isHex(raw)) return undefined
    const transaction = parseTransaction(raw)
    const to = transaction.to ?? '0x'
    const toOperator = transaction.to != null && isAddressEqual(transaction.to, chain.operator)
    const call = toOperator && transaction.data !== undefined ? paymentOfCall(transaction.data, chain) : undefined
    return {
      hash: keccak256(raw),
      to,
      nonce: transaction.nonce ?? 0,
      function: call?.functionName ?? (toOperator ? 'unknown' : 'transfer'),
      withheld: call?.hash !== undefined && withheld.has(call.hash),
      at: Date.now(),
    }
  }
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      const body = await request.text()
      const parsed = Option.getOrUndefined(Schema.decodeUnknownOption(Request)(body))
      const raw = parsed?.params?.[0]
      if (parsed?.method === 'eth_sendRawTransaction' && typeof raw === 'string') {
        const transaction = inspect(raw)
        if (transaction !== undefined) sent.push(transaction)
        if (transaction?.withheld === true)
          return refusal(parsed.id, 'transaction rejected: withheld by the gate rehearsal')
      }
      const method = parsed?.method ?? 'unparsed'
      const began = performance.now()
      const answered = await fetch(upstream, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }).then(
        async (answer) => ({ status: answer.status, text: await answer.text() }),
        (cause: unknown) => ({ status: 0, text: '', cause: String(cause) }),
      )
      const ms = performance.now() - began
      const failure = failureOf(answered)
      count(census, method, ms, failure)
      if (answered.status === 0)
        return Response.json(
          { jsonrpc: '2.0', id: parsed?.id, error: { code: -32603, message: 'upstream' } },
          { status: 502 },
        )
      return new Response(answered.text, {
        status: answered.status,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, sent, withheld, census, stop: () => void server.stop(true) }
}
