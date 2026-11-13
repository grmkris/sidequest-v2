import {
  Amount,
  type ChainDelivery,
  type ChainOutcome,
  type ChainProblem,
  type ChainRejection,
  type ChainSettlement,
  Digest,
  type Receipt,
} from '@sidequest/protocol'
import { Option } from 'effect'
import { type Address, decodeEventLog, type Hex, isAddress, isAddressEqual, isHex } from 'viem'
import { authCaptureEscrowAbi } from './abi/AuthCaptureEscrow.ts'
import { sidequestOperatorAbi } from './abi/SidequestOperator.ts'
import type { Expected } from './Expected.ts'
import type { RawLog } from './ReaderCursors.ts'
import { accountRefOf, wordDigest } from './Words.ts'

/** One field the reader compares: its name, what the agreement says, and what the chain says. */
type Check = readonly [field: string, expected: string, observed: string]

const outcomes: ReadonlyArray<ChainOutcome> = ['Approved', 'AcceptedBySilence', 'Ruled', 'Unruled', 'Undelivered']
const bps = 10_000n

/** A verified fact, or the problem that disqualified the log. */
export type Verified<A> =
  | { readonly _tag: 'Fact'; readonly fact: A }
  | { readonly _tag: 'Problem'; readonly problem: ChainProblem }

/** The fact `build` makes, unless a check fails: then the first failing field is a `receipt_mismatch`. */
const verified = <A>(event: string, checks: ReadonlyArray<Check>, build: () => A): Verified<A> => {
  const failed = checks.find(([, expected, observed]) => observed !== expected)
  if (failed === undefined) return { _tag: 'Fact', fact: build() }
  const [field, expected, observed] = failed
  return { _tag: 'Problem', problem: { event, kind: 'receipt_mismatch', field, expected, observed } }
}

const word = (value: Hex) => value.toLowerCase()
const address = (value: Address) => value.toLowerCase()

/** Where a log sits: its transaction and how many blocks confirm it. */
interface Position {
  readonly transactionHash: Hex
  readonly confirmations: number
}

const receiptOf = (
  expected: Expected,
  operation: Receipt['operation'],
  amount: bigint,
  position: Position,
): Receipt => {
  const { agreement, payment, chain } = expected
  return {
    job: agreement.job,
    rail: 'escrow',
    network: chain.asset.network,
    operation,
    asset: chain.asset.id,
    amount: Amount.make(String(amount)),
    payer: accountRefOf(chain.asset.network, payment.info.payer),
    payee: accountRefOf(chain.asset.network, payment.info.receiver),
    paymentHash: payment.hash,
    transactionHash: position.transactionHash,
    status: 'success',
    confirmations: position.confirmations,
  }
}

interface FundedArgs {
  readonly jobId: Hex
  readonly termsDigest: Hex
  readonly payer: Address
  readonly receiver: Address
  readonly token: Address
  readonly amount: bigint
  readonly deliveryDeadline: number
  readonly reviewWindow: number
  readonly disputeWindow: number
  readonly arbitrationWindow: number
  readonly arbitrator: Address
  readonly authorizationExpiry: number
}

/** `JobFunded`, every field checked against the payment and job parameters built from the agreement. */
const funded = (expected: Expected, args: FundedArgs, position: Position) => {
  const { info, params } = expected.payment
  const checks: ReadonlyArray<Check> = [
    ['jobId', word(params.jobId), word(args.jobId)],
    ['termsDigest', word(params.termsDigest), word(args.termsDigest)],
    ['payer', address(info.payer), address(args.payer)],
    ['receiver', address(info.receiver), address(args.receiver)],
    ['token', address(info.token), address(args.token)],
    ['amount', String(info.maxAmount), String(args.amount)],
    ['deliveryDeadline', String(params.deliveryDeadline), String(args.deliveryDeadline)],
    ['reviewWindow', String(params.reviewWindow), String(args.reviewWindow)],
    ['disputeWindow', String(params.disputeWindow), String(args.disputeWindow)],
    ['arbitrationWindow', String(params.arbitrationWindow), String(args.arbitrationWindow)],
    ['arbitrator', address(params.arbitrator), address(args.arbitrator)],
    ['authorizationExpiry', String(info.authorizationExpiry), String(args.authorizationExpiry)],
  ]
  return verified('JobFunded', checks, () => receiptOf(expected, 'authorize', info.maxAmount, position))
}

interface DeliveredArgs {
  readonly termsDigest: Hex
  readonly deliveryHash: Hex
  readonly deliveredAt: number
  readonly reviewDeadline: number
}

const delivered = (expected: Expected, args: DeliveredArgs, position: Position) => {
  const { params } = expected.payment
  const checks: ReadonlyArray<Check> = [
    ['termsDigest', word(params.termsDigest), word(args.termsDigest)],
    ['reviewDeadline', String(args.deliveredAt + params.reviewWindow), String(args.reviewDeadline)],
  ]
  return verified('JobDelivered', checks, (): ChainDelivery => ({
    deliveryHash: Digest.make(wordDigest(args.deliveryHash)),
    deliveredAt: args.deliveredAt,
    reviewEndsAt: args.reviewDeadline,
    transactionHash: position.transactionHash,
  }))
}

interface RejectedArgs {
  readonly termsDigest: Hex
  readonly rejectedAt: number
  readonly arbitrationDeadline: number
}

const rejected = (expected: Expected, args: RejectedArgs, position: Position) => {
  const { params } = expected.payment
  const deadline = args.rejectedAt + params.disputeWindow + params.arbitrationWindow
  const checks: ReadonlyArray<Check> = [
    ['termsDigest', word(params.termsDigest), word(args.termsDigest)],
    ['arbitrationDeadline', String(deadline), String(args.arbitrationDeadline)],
  ]
  return verified('JobRejected', checks, (): ChainRejection => ({
    rejectedAt: args.rejectedAt,
    arbitrationEndsAt: args.arbitrationDeadline,
    transactionHash: position.transactionHash,
  }))
}

interface SettledArgs {
  readonly termsDigest: Hex
  readonly outcome: number
  readonly workerShareBps: number
  readonly capturedAmount: bigint
  readonly feeAmount: bigint
  readonly refundedAmount: bigint
  readonly settledAt: number
}

/** The share each outcome must carry: all for an approval or silence, none for a refund, any for a ruling. */
const shareFor = (outcome: ChainOutcome | undefined, share: number) => {
  if (outcome === 'Approved' || outcome === 'AcceptedBySilence') return '10000'
  if (outcome === 'Unruled' || outcome === 'Undelivered') return '0'
  return String(share)
}

/** The receipts of a capture of `captured` and a void of the rest; the amount is positive, so at least one. */
const settlementReceipts = (expected: Expected, captured: bigint, position: Position) => {
  const amount = expected.payment.info.maxAmount
  const voided = receiptOf(expected, 'void', amount - captured, position)
  if (captured === 0n) return [voided] as const
  const capture = receiptOf(expected, 'capture', captured, position)
  return captured === amount ? ([capture] as const) : ([capture, voided] as const)
}

/** `JobSettled`: the outcome and its amounts, recomputed from the payment and the fee as the operator does. */
const settled = (expected: Expected, args: SettledArgs, position: Position) => {
  const { info, params } = expected.payment
  const outcome = outcomes[args.outcome - 1]
  const captured = (info.maxAmount * BigInt(args.workerShareBps)) / bps
  const fee = (captured * BigInt(expected.chain.feeBps)) / bps
  const checks: ReadonlyArray<Check> = [
    ['termsDigest', word(params.termsDigest), word(args.termsDigest)],
    ['outcome', outcome ?? outcomes.join('|'), outcome ?? String(args.outcome)],
    ['workerShareBps', shareFor(outcome, args.workerShareBps), String(args.workerShareBps)],
    ['capturedAmount', String(captured), String(args.capturedAmount)],
    ['feeAmount', String(fee), String(args.feeAmount)],
    ['refundedAmount', String(info.maxAmount - captured), String(args.refundedAmount)],
  ]
  return verified('JobSettled', checks, (): ChainSettlement => ({
    outcome: outcome ?? 'Unruled',
    workerShareBps: args.workerShareBps,
    settledAt: args.settledAt,
    receipts: settlementReceipts(expected, captured, position),
  }))
}

/** The escrow's own `reclaim` by the payer, after `authorizationExpiry`: everything back to the buyer. */
const reclaimed = (expected: Expected, amount: bigint, settledAt: number, position: Position) =>
  verified(
    'PaymentReclaimed',
    [['amount', String(expected.payment.info.maxAmount), String(amount)]],
    (): ChainSettlement => ({
      outcome: 'Reclaimed',
      workerShareBps: 0,
      settledAt,
      receipts: [receiptOf(expected, 'reclaim', amount, position)],
    }),
  )

/** What one log says, verified: a fact of one kind, a problem, or nothing the reader uses. */
export type LogReading =
  | { readonly kind: 'funding'; readonly reading: Verified<Receipt> }
  | { readonly kind: 'delivery'; readonly reading: Verified<ChainDelivery> }
  | { readonly kind: 'rejection'; readonly reading: Verified<ChainRejection> }
  | { readonly kind: 'settlement'; readonly reading: Verified<ChainSettlement> }
  | { readonly kind: 'problem'; readonly problem: ChainProblem }
  | { readonly kind: 'ignored' }

const inconclusive = (event: string, field: string): LogReading => ({
  kind: 'problem',
  problem: { event, kind: 'inconclusive', field, expected: 'present', observed: '' },
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

const decodeOperator = Option.liftThrowable((data: Hex, topics: readonly [Hex, ...Array<Hex>]) =>
  decodeEventLog({ abi: sidequestOperatorAbi, data, topics: [...topics], strict: true }),
)
const decodeEscrow = Option.liftThrowable((data: Hex, topics: readonly [Hex, ...Array<Hex>]) =>
  decodeEventLog({ abi: authCaptureEscrowAbi, data, topics: [...topics], strict: true }),
)

const readOperator = (expected: Expected, data: Hex, topics: readonly [Hex, ...Array<Hex>], position: Position) => {
  const decoded = decodeOperator(data, topics)
  if (Option.isNone(decoded)) return inconclusive('SidequestOperator', 'log')
  const event = decoded.value
  switch (event.eventName) {
    case 'JobFunded':
      return { kind: 'funding', reading: funded(expected, event.args, position) } as const
    case 'JobDelivered':
      return { kind: 'delivery', reading: delivered(expected, event.args, position) } as const
    case 'JobRejected':
      return { kind: 'rejection', reading: rejected(expected, event.args, position) } as const
    case 'JobSettled':
      return { kind: 'settlement', reading: settled(expected, event.args, position) } as const
    // A delegated delivery is read from its `JobDelivered`, like any other; a revocation moves nothing.
    case 'JobDeliveryDelegated':
    case 'DeliveryDelegateRevoked':
    case 'EIP712DomainChanged':
      return { kind: 'ignored' } as const
  }
}

/**
 * Reads one confirmed log about the payment: an operator event, or the escrow's `PaymentReclaimed`, verified against
 * what was agreed. `head` counts its confirmations; `blockTime` is the log's block timestamp, which only a reclaim
 * needs (the escrow does not log the time).
 */
export const readLog = (expected: Expected, log: RawLog, head: bigint, blockTime: number): LogReading => {
  const parts = hexParts(log)
  if (Option.isNone(parts)) return inconclusive('log', 'encoding')
  const { address: emitter, data, topics } = parts.value
  const fromOperator = isAddressEqual(emitter, expected.chain.operator)
  if (!fromOperator && !isAddressEqual(emitter, expected.chain.escrow)) return { kind: 'ignored' }
  const event = fromOperator ? 'SidequestOperator' : 'AuthCaptureEscrow'
  if (log.transactionHash === null || !isHex(log.transactionHash)) return inconclusive(event, 'transactionHash')
  const position = {
    transactionHash: log.transactionHash,
    confirmations: Number(head - BigInt(log.blockNumber) + 1n),
  }
  if (fromOperator) return readOperator(expected, data, topics, position)
  const decoded = decodeEscrow(data, topics)
  if (Option.isNone(decoded) || decoded.value.eventName !== 'PaymentReclaimed') return { kind: 'ignored' }
  return { kind: 'settlement', reading: reclaimed(expected, decoded.value.args.amount, blockTime, position) }
}
