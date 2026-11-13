import type { Agreement, Terms } from '@sidequest/protocol'
import { Effect, Option, Schema } from 'effect'
import { type Address, encodeAbiParameters, getAddress, type Hex, isAddressEqual, keccak256, toHex } from 'viem'
import { operatorMargin, type SettlementChain } from './SettlementChain.ts'
import { digestWord, jobIdWord } from './Words.ts'

/** `SidequestOperator.JobParams`: what `PaymentInfo` has no field for, bound into it by the salt. */
export interface JobParams {
  readonly jobId: Hex
  readonly termsDigest: Hex
  readonly deliveryDeadline: number
  readonly reviewWindow: number
  readonly disputeWindow: number
  readonly arbitrationWindow: number
  readonly arbitrator: Address
}

/** `AuthCaptureEscrow.PaymentInfo`. */
export interface PaymentInfo {
  readonly operator: Address
  readonly payer: Address
  readonly receiver: Address
  readonly token: Address
  readonly maxAmount: bigint
  readonly preApprovalExpiry: number
  readonly authorizationExpiry: number
  readonly refundExpiry: number
  readonly minFeeBps: number
  readonly maxFeeBps: number
  readonly feeReceiver: Address
  readonly salt: bigint
}

/** One job's escrow payment: its parameters, the escrow's hash that keys it everywhere, and the ERC-3009 nonce. */
export interface Payment {
  readonly params: JobParams
  readonly info: PaymentInfo
  /** `AuthCaptureEscrow.getHash(info)`. */
  readonly hash: Hex
  /** The payer-agnostic hash the collector uses as the ERC-3009 nonce. */
  readonly nonce: Hex
}

/** The agreement cannot be paid through this chain's escrow as it stands. */
export class UnpayableAgreement extends Schema.TaggedError<UnpayableAgreement>()('UnpayableAgreement', {
  reason: Schema.Literals(['network', 'asset', 'amount', 'deadline', 'arbitrator']),
}) {}

const jobParamsTypehash = keccak256(
  toHex(
    'JobParams(bytes32 jobId,bytes32 termsDigest,uint48 deliveryDeadline,uint32 reviewWindow,uint32 disputeWindow,uint32 arbitrationWindow,address arbitrator)',
  ),
)

const paymentInfoTypehash = keccak256(
  toHex(
    'PaymentInfo(address operator,address payer,address receiver,address token,uint120 maxAmount,uint48 preApprovalExpiry,uint48 authorizationExpiry,uint48 refundExpiry,uint16 minFeeBps,uint16 maxFeeBps,address feeReceiver,uint256 salt)',
  ),
)

const maxUint48 = 2 ** 48 - 1
const maxUint120 = 2n ** 120n - 1n

/** `SidequestOperator.jobSalt(params)`: the EIP-712 struct hash of the parameters, as a number. */
export const jobSalt = (params: JobParams): bigint =>
  BigInt(
    keccak256(
      encodeAbiParameters(
        [
          { type: 'bytes32' },
          { type: 'bytes32' },
          { type: 'bytes32' },
          { type: 'uint48' },
          { type: 'uint32' },
          { type: 'uint32' },
          { type: 'uint32' },
          { type: 'address' },
        ],
        [
          jobParamsTypehash,
          params.jobId,
          params.termsDigest,
          params.deliveryDeadline,
          params.reviewWindow,
          params.disputeWindow,
          params.arbitrationWindow,
          params.arbitrator,
        ],
      ),
    ),
  )

const paymentInfoStructHash = (info: PaymentInfo) =>
  keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint120' },
        { type: 'uint48' },
        { type: 'uint48' },
        { type: 'uint48' },
        { type: 'uint16' },
        { type: 'uint16' },
        { type: 'address' },
        { type: 'uint256' },
      ],
      [
        paymentInfoTypehash,
        info.operator,
        info.payer,
        info.receiver,
        info.token,
        info.maxAmount,
        info.preApprovalExpiry,
        info.authorizationExpiry,
        info.refundExpiry,
        info.minFeeBps,
        info.maxFeeBps,
        info.feeReceiver,
        info.salt,
      ],
    ),
  )

/** `AuthCaptureEscrow.getHash(info)` on `chain`: the payment's hash, bound to the chain id and the escrow. */
export const paymentInfoHash = (info: PaymentInfo, chain: Pick<SettlementChain, 'chainId' | 'escrow'>): Hex =>
  keccak256(
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }],
      [BigInt(chain.chainId), chain.escrow, paymentInfoStructHash(info)],
    ),
  )

/** The job parameters an agreement fixes on `chain`: its windows, its deadline and the chain's arbitrator. */
export const jobParamsOf = (agreement: Agreement, chain: SettlementChain): JobParams => ({
  jobId: jobIdWord(agreement.job),
  termsDigest: digestWord(agreement.termsDigest),
  deliveryDeadline: agreement.terms.deliveryDeadline,
  reviewWindow: agreement.terms.reviewWindowSeconds,
  disputeWindow: agreement.terms.disputeWindowSeconds,
  arbitrationWindow: agreement.terms.arbitrationWindowSeconds,
  arbitrator: chain.arbitrator,
})

/**
 * The earliest `authorizationExpiry` the operator accepts: the delivery deadline plus every window plus `MARGIN`, so
 * the payer's `reclaim` can never pre-empt a window still open.
 */
export const authorizationExpiryOf = (params: JobParams) =>
  params.deliveryDeadline + params.reviewWindow + params.disputeWindow + params.arbitrationWindow + operatorMargin

const refuse = (reason: UnpayableAgreement['reason']) => Effect.fail(new UnpayableAgreement({ reason }))

/** Fails with the first way terms cannot be paid with `params` between these parties on `chain`. */
const payable = (terms: Terms, params: JobParams, parties: Parties, chain: SettlementChain) => {
  const amount = BigInt(terms.amount)
  if (terms.network !== chain.asset.network) return refuse('network')
  if (terms.asset !== chain.asset.id) return refuse('asset')
  if (amount === 0n || amount > maxUint120) return refuse('amount')
  if (authorizationExpiryOf(params) > maxUint48) return refuse('deadline')
  if (isAddressEqual(chain.arbitrator, parties.payer) || isAddressEqual(chain.arbitrator, parties.receiver))
    return refuse('arbitrator')
  return Effect.succeed(amount)
}

/** Who pays and who is paid. */
export interface Parties {
  readonly payer: Address
  readonly receiver: Address
}

/** The escrow payment of `maxAmount` with `params` between the parties on `chain` (see `paymentOf`). */
const paymentWith = (params: JobParams, maxAmount: bigint, parties: Parties, chain: SettlementChain): Payment => {
  const authorizationExpiry = authorizationExpiryOf(params)
  const info: PaymentInfo = {
    operator: chain.operator,
    payer: getAddress(parties.payer),
    receiver: getAddress(parties.receiver),
    token: chain.token,
    maxAmount,
    preApprovalExpiry: params.deliveryDeadline,
    authorizationExpiry,
    refundExpiry: authorizationExpiry,
    minFeeBps: chain.feeBps,
    maxFeeBps: chain.feeBps,
    feeReceiver: chain.feeReceiver,
    salt: jobSalt(params),
  }
  return {
    params,
    info,
    hash: paymentInfoHash(info, chain),
    nonce: paymentInfoHash({ ...info, payer: '0x0000000000000000000000000000000000000000' }, chain),
  }
}

/**
 * The exact escrow payment for an agreement between `payer` and `receiver` on `chain`: the operator's fee terms, the
 * whole amount, the minimal `authorizationExpiry`, a pre-approval that lapses at the delivery deadline (funding is
 * impossible from then on), and `salt = jobSalt(params)`. Deterministic: the same inputs build the same payment.
 */
export const paymentOf = Effect.fn('Sidequest.Settlement.paymentOf')(function* (
  agreement: Agreement,
  parties: Parties,
  chain: SettlementChain,
) {
  const params = jobParamsOf(agreement, chain)
  const maxAmount = yield* payable(agreement.terms, params, parties, chain)
  return paymentWith(params, maxAmount, parties, chain)
})

/**
 * The escrow payment for a Nostr-native job, built exactly as `paymentOf` builds one for an agreement: `job` is the
 * request event's id (the `bytes32 jobId`), `termsDigest` the proposal's, both as 64 hex digits, and the terms the
 * proposal's signed terms. Deterministic, so a client and the server build the same payment from the same proposal.
 */
export const termsPaymentOf = Effect.fn('Sidequest.Settlement.termsPaymentOf')(function* (
  signed: { readonly job: string; readonly termsDigest: string; readonly terms: Terms },
  parties: Parties,
  chain: SettlementChain,
) {
  const { terms } = signed
  const params: JobParams = {
    jobId: `0x${signed.job}`,
    termsDigest: `0x${signed.termsDigest}`,
    deliveryDeadline: terms.deliveryDeadline,
    reviewWindow: terms.reviewWindowSeconds,
    disputeWindow: terms.disputeWindowSeconds,
    arbitrationWindow: terms.arbitrationWindowSeconds,
    arbitrator: chain.arbitrator,
  }
  const maxAmount = yield* payable(terms, params, parties, chain)
  return paymentWith(params, maxAmount, parties, chain)
})

/** What a `JobFunded` log says of its payment: the job, the parties, the amount and the parameters it stored. */
export interface FundedPayment {
  readonly paymentHash: string
  readonly job: string
  readonly termsDigest: string
  readonly payer: Address
  readonly receiver: Address
  readonly amount: bigint
  readonly deliveryDeadline: number
  readonly reviewWindow: number
  readonly disputeWindow: number
  readonly arbitrationWindow: number
  readonly arbitrator: Address
  readonly authorizationExpiry: number
}

/**
 * The escrow payment a `JobFunded` log is about, rebuilt the way `paymentOf` builds one, if it hashes to the log's
 * payment hash. A payment someone funded directly on chain with other expiries (`preApprovalExpiry`, `refundExpiry`)
 * cannot be rebuilt from the log alone: the operator's later calls need its exact `PaymentInfo`, so it is `None`.
 */
export const fundedPaymentOf = (funded: FundedPayment, chain: SettlementChain): Option.Option<Payment> => {
  const params: JobParams = {
    jobId: `0x${funded.job}`,
    termsDigest: `0x${funded.termsDigest}`,
    deliveryDeadline: funded.deliveryDeadline,
    reviewWindow: funded.reviewWindow,
    disputeWindow: funded.disputeWindow,
    arbitrationWindow: funded.arbitrationWindow,
    arbitrator: funded.arbitrator,
  }
  const payment = paymentWith(params, funded.amount, funded, chain)
  return payment.hash === funded.paymentHash.toLowerCase() &&
    payment.info.authorizationExpiry === funded.authorizationExpiry
    ? Option.some(payment)
    : Option.none()
}
