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

export interface RpcProxy {
  readonly url: string
  /** Every `eth_sendRawTransaction` the proxy saw, in order. */
  readonly sent: Array<Sent>
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

/** Start the proxy in front of `upstream`; calls to `operator` for a withheld payment are refused. */
export const startProxy = (
  upstream: string,
  chain: { readonly chainId: number; readonly escrow: Address; readonly operator: Address },
): RpcProxy => {
  const sent: Array<Sent> = []
  const withheld = new Set<Hex>()
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
      const answer = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      return new Response(await answer.text(), {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, sent, withheld, stop: () => void server.stop(true) }
}
