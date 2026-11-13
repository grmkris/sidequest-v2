import type { TypedData as ProtocolTypedData } from '@sidequest/protocol'
import type { Address, Hex } from 'viem'
import type { Payment } from './Payment.ts'
import type { SettlementChain } from './SettlementChain.ts'

const receiveWithAuthorizationTypes = {
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

const deliveryTypes = {
  Delivery: [
    { name: 'paymentInfoHash', type: 'bytes32' },
    { name: 'deliveryHash', type: 'bytes32' },
  ],
} as const
const deliveryDelegateTypes = {
  DeliveryDelegate: [
    { name: 'paymentInfoHash', type: 'bytes32' },
    { name: 'delegate', type: 'address' },
    { name: 'expiry', type: 'uint48' },
  ],
} as const
const approvalTypes = {
  Approval: [
    { name: 'paymentInfoHash', type: 'bytes32' },
    { name: 'deliveryHash', type: 'bytes32' },
  ],
} as const
const rejectionTypes = {
  Rejection: [
    { name: 'paymentInfoHash', type: 'bytes32' },
    { name: 'deliveryHash', type: 'bytes32' },
  ],
} as const
const rulingTypes = {
  Ruling: [
    { name: 'paymentInfoHash', type: 'bytes32' },
    { name: 'workerShareBps', type: 'uint16' },
  ],
} as const

interface Domain {
  readonly name: string
  readonly version: string
  readonly chainId: number
  readonly verifyingContract: Address
}

const operatorDomain = (chain: SettlementChain): Domain => ({
  name: 'SidequestOperator',
  version: '1',
  chainId: chain.chainId,
  verifyingContract: chain.operator,
})

/**
 * The ERC-3009 `ReceiveWithAuthorization` the buyer signs to fund a job: the whole amount from the payer to the
 * collector, valid until the pre-approval expiry, with the payer-agnostic payment hash as its nonce. The token's own
 * EIP-712 domain verifies it.
 */
export const fundingTypedData = (payment: Payment, chain: SettlementChain) => ({
  domain: { ...chain.tokenDomain, chainId: chain.chainId, verifyingContract: chain.token },
  types: receiveWithAuthorizationTypes,
  primaryType: 'ReceiveWithAuthorization' as const,
  message: {
    from: payment.info.payer,
    to: chain.collector,
    value: payment.info.maxAmount,
    validAfter: 0n,
    validBefore: BigInt(payment.info.preApprovalExpiry),
    nonce: payment.nonce,
  },
})

/** The worker's `Delivery`: records `deliveryHash` on chain for the payment. */
export const deliveryTypedData = (paymentHash: Hex, deliveryHash: Hex, chain: SettlementChain) => ({
  domain: operatorDomain(chain),
  types: deliveryTypes,
  primaryType: 'Delivery' as const,
  message: { paymentInfoHash: paymentHash, deliveryHash },
})

/**
 * The worker's `DeliveryDelegate`: lets `delegate` (an agent's EVM key) record the payment's delivery with its own
 * `Delivery` signature, strictly before `expiry` (Unix seconds). That one payment and that one action only.
 */
export const deliveryDelegateTypedData = (
  paymentHash: Hex,
  delegate: Address,
  expiry: number,
  chain: SettlementChain,
) => ({
  domain: operatorDomain(chain),
  types: deliveryDelegateTypes,
  primaryType: 'DeliveryDelegate' as const,
  message: { paymentInfoHash: paymentHash, delegate, expiry },
})

/** The buyer's `Approval` of the recorded delivery: pays the worker. */
export const approvalTypedData = (paymentHash: Hex, deliveryHash: Hex, chain: SettlementChain) => ({
  domain: operatorDomain(chain),
  types: approvalTypes,
  primaryType: 'Approval' as const,
  message: { paymentInfoHash: paymentHash, deliveryHash },
})

/** The buyer's `Rejection` of the recorded delivery: opens a dispute. */
export const rejectionTypedData = (paymentHash: Hex, deliveryHash: Hex, chain: SettlementChain) => ({
  domain: operatorDomain(chain),
  types: rejectionTypes,
  primaryType: 'Rejection' as const,
  message: { paymentInfoHash: paymentHash, deliveryHash },
})

/** The arbitrator's `Ruling`: the worker's share of a disputed job, in basis points. */
export const rulingTypedData = (paymentHash: Hex, workerShareBps: number, chain: SettlementChain) => ({
  domain: operatorDomain(chain),
  types: rulingTypes,
  primaryType: 'Ruling' as const,
  message: { paymentInfoHash: paymentHash, workerShareBps },
})

interface AnyTypedData {
  readonly domain: Domain
  readonly types: Readonly<Record<string, ReadonlyArray<{ readonly name: string; readonly type: string }>>>
  readonly primaryType: string
  readonly message: Readonly<Record<string, bigint | number | string>>
}

/** Typed data as the protocol carries it to a wallet: every integer a decimal string. */
export const toProtocolTypedData = (typed: AnyTypedData): ProtocolTypedData => ({
  domain: typed.domain,
  types: Object.fromEntries(
    Object.entries(typed.types).map(([name, fields]) => [name, fields.map((field) => ({ ...field }))]),
  ),
  primaryType: typed.primaryType,
  message: Object.fromEntries(Object.entries(typed.message).map(([key, value]) => [key, String(value)])),
})
