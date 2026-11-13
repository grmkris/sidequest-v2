import { Effect, Option } from 'effect'
import {
  type Address,
  decodeEventLog,
  getAbiItem,
  getAddress,
  type Hex,
  isAddress,
  isAddressEqual,
  isHex,
  numberToHex,
  type PublicClient,
  toEventSelector,
} from 'viem'
import { authCaptureEscrowAbi } from './abi/AuthCaptureEscrow.ts'
import { sidequestOperatorAbi } from './abi/SidequestOperator.ts'
import { rpcCall } from './ChainRpc.ts'
import { maxLogRange, toRaw } from './LogScan.ts'
import type { RawLog } from './ReaderCursors.ts'
import type { SettlementChain } from './SettlementChain.ts'
import { hexParts } from './Verify.ts'
import { accountRefOf, wordDigest } from './Words.ts'

// Every job's logs, not one payment's: what the index records as chain facts. The chain reader (`ChainReader.ts`)
// checks one payment's logs against what was agreed; this reads every operator log and every escrow reclaim as plain
// facts, and leaves judging them to whoever folds a job (`@sidequest/fold`), which checks a funding against the
// proposal whose terms it names.

/** Where a log sits on its chain. */
interface At {
  readonly block: number
  readonly logIndex: number
}

/** What every fact carries: where its log is, its transaction, and the escrow payment it is about. */
interface Located {
  readonly at: At
  readonly transactionHash: string
  readonly paymentHash: string
}

/**
 * One log as a plain fact, in the shape `@sidequest/fold`'s `ChainFact` encodes to (plus its transaction hash): the
 * operator's `JobFunded` (its `jobId` word as 64 hex digits, the job's request event id when it is one),
 * `JobDelivered`, `JobRejected` and `JobSettled`, and the escrow's `PaymentReclaimed` with its block's time.
 */
export type JobLogFact =
  | (Located & {
      readonly _tag: 'Funded'
      readonly job: string
      readonly termsDigest: string
      readonly payer: string
      readonly receiver: string
      readonly asset: string
      readonly amount: string
      readonly deliveryDeadline: number
      readonly reviewWindowSeconds: number
      readonly disputeWindowSeconds: number
      readonly arbitrationWindowSeconds: number
      readonly arbitrator: string
      readonly authorizationExpiry: number
    })
  | (Located & {
      readonly _tag: 'Delivered'
      readonly deliveryHash: string
      readonly deliveredAt: number
      readonly reviewEndsAt: number
    })
  | (Located & { readonly _tag: 'Rejected'; readonly rejectedAt: number; readonly arbitrationEndsAt: number })
  | (Located & {
      readonly _tag: 'Settled'
      readonly outcome: string
      readonly workerShareBps: number
      readonly capturedAmount: string
      readonly feeAmount: string
      readonly refundedAmount: string
      readonly settledAt: number
    })
  | (Located & { readonly _tag: 'Reclaimed'; readonly amount: string; readonly reclaimedAt: number })

const outcomes = ['Approved', 'AcceptedBySilence', 'Ruled', 'Unruled', 'Undelivered'] as const

/** The selectors of the logs that make facts: the operator's four job events and the escrow's reclaim. */
const factTopics: ReadonlyArray<Hex> = [
  toEventSelector(getAbiItem({ abi: sidequestOperatorAbi, name: 'JobFunded' })),
  toEventSelector(getAbiItem({ abi: sidequestOperatorAbi, name: 'JobDelivered' })),
  toEventSelector(getAbiItem({ abi: sidequestOperatorAbi, name: 'JobRejected' })),
  toEventSelector(getAbiItem({ abi: sidequestOperatorAbi, name: 'JobSettled' })),
  toEventSelector(getAbiItem({ abi: authCaptureEscrowAbi, name: 'PaymentReclaimed' })),
]

/**
 * The fact-making logs of the operator and the escrow from `from` to `to`, whatever payment they are about, in ranges
 * an RPC accepts. The caller passes only confirmed blocks.
 */
export const jobLogsBetween = Effect.fnUntraced(function* (
  rpc: PublicClient,
  chain: SettlementChain,
  from: bigint,
  to: bigint,
) {
  const found: Array<RawLog> = []
  for (let start = from; start <= to; start += maxLogRange) {
    const end = start + maxLogRange - 1n < to ? start + maxLogRange - 1n : to
    const logs = yield* rpcCall('eth_getLogs', () =>
      rpc.request({
        method: 'eth_getLogs',
        params: [
          {
            address: [chain.operator, chain.escrow],
            fromBlock: numberToHex(start),
            toBlock: numberToHex(end),
            topics: [[...factTopics]],
          },
        ],
      }),
    )
    found.push(...logs.flatMap((log) => Option.toArray(toRaw(log))))
  }
  return found
})

const decodeOperator = Option.liftThrowable((data: Hex, topics: readonly [Hex, ...Array<Hex>]) =>
  decodeEventLog({ abi: sidequestOperatorAbi, data, topics: [...topics], strict: true }),
)
const decodeEscrow = Option.liftThrowable((data: Hex, topics: readonly [Hex, ...Array<Hex>]) =>
  decodeEventLog({ abi: authCaptureEscrowAbi, data, topics: [...topics], strict: true }),
)

const word = (value: Hex) => value.toLowerCase()

/** The asset a token is on the chain: the configured asset's id for its token, CAIP-19 `erc20` otherwise. */
const assetOf = (chain: SettlementChain, token: Address) =>
  isAddressEqual(token, chain.token) ? chain.asset.id : `${chain.asset.network}/erc20:${getAddress(token)}`

const account = (chain: SettlementChain, address: Address) => accountRefOf(chain.asset.network, address)

const operatorFact = (
  chain: SettlementChain,
  located: Located,
  data: Hex,
  topics: readonly [Hex, ...Array<Hex>],
): Option.Option<JobLogFact> => {
  const decoded = decodeOperator(data, topics)
  if (Option.isNone(decoded)) return Option.none()
  const event = decoded.value
  switch (event.eventName) {
    case 'JobFunded': {
      const { args } = event
      return Option.some({
        _tag: 'Funded',
        ...located,
        job: wordDigest(args.jobId),
        termsDigest: wordDigest(args.termsDigest),
        payer: account(chain, args.payer),
        receiver: account(chain, args.receiver),
        asset: assetOf(chain, args.token),
        amount: String(args.amount),
        deliveryDeadline: args.deliveryDeadline,
        reviewWindowSeconds: args.reviewWindow,
        disputeWindowSeconds: args.disputeWindow,
        arbitrationWindowSeconds: args.arbitrationWindow,
        arbitrator: account(chain, args.arbitrator),
        authorizationExpiry: args.authorizationExpiry,
      })
    }
    case 'JobDelivered':
      return Option.some({
        _tag: 'Delivered',
        ...located,
        deliveryHash: word(event.args.deliveryHash),
        deliveredAt: event.args.deliveredAt,
        reviewEndsAt: event.args.reviewDeadline,
      })
    case 'JobRejected':
      return Option.some({
        _tag: 'Rejected',
        ...located,
        rejectedAt: event.args.rejectedAt,
        arbitrationEndsAt: event.args.arbitrationDeadline,
      })
    case 'JobSettled': {
      const { args } = event
      const outcome = outcomes[args.outcome - 1]
      // `None` is never emitted; a log that says it is no fact.
      if (outcome === undefined) return Option.none()
      return Option.some({
        _tag: 'Settled',
        ...located,
        outcome,
        workerShareBps: args.workerShareBps,
        capturedAmount: String(args.capturedAmount),
        feeAmount: String(args.feeAmount),
        refundedAmount: String(args.refundedAmount),
        settledAt: args.settledAt,
      })
    }
    case 'EIP712DomainChanged':
      return Option.none()
  }
}

/** Where a log is: its block, its index there and its transaction, when the RPC said all three. */
const locationOf = (log: RawLog) =>
  log.logIndex === null || log.transactionHash === null || !isHex(log.transactionHash)
    ? Option.none()
    : Option.some({
        at: { block: Number(BigInt(log.blockNumber)), logIndex: log.logIndex },
        transactionHash: word(log.transactionHash),
      })

/**
 * One confirmed log as a fact: an operator job event, or the escrow's `PaymentReclaimed` (dated `blockTime`, its
 * block's timestamp, since the escrow logs no time). Anything else, or a log that does not decode, is no fact.
 */
export const jobLogFact = (chain: SettlementChain, log: RawLog, blockTime: number): Option.Option<JobLogFact> => {
  const parts = hexParts(log)
  const where = locationOf(log)
  if (Option.isNone(parts) || Option.isNone(where)) return Option.none()
  const { address, data, topics } = parts.value
  const paymentHash = topics[1]
  if (paymentHash === undefined) return Option.none()
  const located: Located = { ...where.value, paymentHash: word(paymentHash) }
  if (isAddressEqual(address, chain.operator)) return operatorFact(chain, located, data, topics)
  if (!isAddressEqual(address, chain.escrow)) return Option.none()
  const decoded = decodeEscrow(data, topics)
  if (Option.isNone(decoded) || decoded.value.eventName !== 'PaymentReclaimed') return Option.none()
  return Option.some({
    _tag: 'Reclaimed',
    ...located,
    amount: String(decoded.value.args.amount),
    reclaimedAt: blockTime,
  })
}

/** Whether a log needs its block's timestamp to be read: only the escrow's reclaim does. */
export const needsBlockTime = (chain: SettlementChain, log: RawLog) =>
  isAddress(log.address, { strict: false }) && isAddressEqual(log.address, chain.escrow)
