import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Schema } from 'effect'
import { domainSeparator, getAddress, hashTypedData, type Hex, isHex } from 'viem'
import { describe, expect, it } from 'vitest'
import { authCaptureEscrowAbi } from '../src/abi/AuthCaptureEscrow.ts'
import { sidequestOperatorAbi, sidequestOperatorSource } from '../src/abi/SidequestOperator.ts'
import { jobSalt, type JobParams, type Payment, type PaymentInfo, paymentInfoHash } from '../src/Payment.ts'
import { arcTestnet } from '../src/SettlementChain.ts'
import {
  approvalTypedData,
  deliveryTypedData,
  fundingTypedData,
  rejectionTypedData,
  rulingTypedData,
} from '../src/TypedData.ts'
import vectors from './fixtures/vectors.json' with { type: 'json' }

// The vectors are what the Foundry build computes (`contracts/script/SettlementVectors.s.sol`, through
// `bun tools/settlement-bindings.ts`): the real escrow's `getHash`, the operator's `jobSalt` and digests, and the
// ERC-3009 digest the token checks. Each expectation below comes from the contracts, never from the builders.

const Hex32 = Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]{64}$/))
const hex = (value: string): Hex => {
  if (!isHex(value)) throw new Error(`${value} is not hex`)
  return value
}

const { deployment } = vectors
const chain = {
  ...arcTestnet({
    operator: deployment.operator,
    feeReceiver: deployment.feeReceiver,
    arbitrator: '0x00000000000000000000000000000000000A4b17',
    feeBps: deployment.feeBps,
  }),
  chainId: deployment.chainId,
  escrow: getAddress(deployment.escrow),
  collector: getAddress(deployment.collector),
  token: getAddress(deployment.token),
  // commerce-payments' MockERC3009Token: Solady's ERC20 with the name hash "USD Coin" and Solady's default version.
  tokenDomain: { name: 'USD Coin', version: '1' },
}

type Case = (typeof vectors.cases)[number]

const paramsOf = (vector: Case): JobParams => ({
  jobId: hex(vector.jobId),
  termsDigest: hex(vector.termsDigest),
  deliveryDeadline: vector.deliveryDeadline,
  reviewWindow: vector.reviewWindow,
  disputeWindow: vector.disputeWindow,
  arbitrationWindow: vector.arbitrationWindow,
  arbitrator: getAddress(vector.arbitrator),
})

const infoOf = (vector: Case): PaymentInfo => ({
  operator: chain.operator,
  payer: getAddress(vector.payer),
  receiver: getAddress(vector.receiver),
  token: chain.token,
  maxAmount: BigInt(vector.amount),
  preApprovalExpiry: vector.deliveryDeadline,
  authorizationExpiry: vector.authorizationExpiry,
  refundExpiry: vector.authorizationExpiry,
  minFeeBps: chain.feeBps,
  maxFeeBps: chain.feeBps,
  feeReceiver: chain.feeReceiver,
  salt: BigInt(vector.salt),
})

const paymentOfVector = (vector: Case): Payment => ({
  params: paramsOf(vector),
  info: infoOf(vector),
  hash: hex(vector.paymentInfoHash),
  nonce: hex(vector.payerAgnosticHash),
})

describe.each(vectors.cases)('the $name vector', (vector) => {
  it('salts the payment with the struct hash of the job parameters', () => {
    expect(jobSalt(paramsOf(vector))).toBe(BigInt(vector.salt))
  })

  it("hashes the payment as the escrow's getHash does, with and without the payer", () => {
    const info = infoOf(vector)
    expect(paymentInfoHash(info, chain)).toBe(vector.paymentInfoHash)
    expect(paymentInfoHash({ ...info, payer: '0x0000000000000000000000000000000000000000' }, chain)).toBe(
      vector.payerAgnosticHash,
    )
  })

  it('builds the typed data whose digests the operator checks', () => {
    const hash = hex(vector.paymentInfoHash)
    const delivery = hex(vector.deliveryHash)
    expect(hashTypedData(deliveryTypedData(hash, delivery, chain))).toBe(vector.deliveryDigest)
    expect(hashTypedData(approvalTypedData(hash, delivery, chain))).toBe(vector.approvalDigest)
    expect(hashTypedData(rejectionTypedData(hash, delivery, chain))).toBe(vector.rejectionDigest)
    expect(hashTypedData(rulingTypedData(hash, vector.workerShareBps, chain))).toBe(vector.rulingDigest)
  })

  it("builds the ERC-3009 authorization whose digest the token checks for the collector's call", () => {
    expect(hashTypedData(fundingTypedData(paymentOfVector(vector), chain))).toBe(vector.receiveWithAuthorizationDigest)
  })
})

const names = (abi: ReadonlyArray<{ readonly type: string; readonly name?: string }>, type: string) =>
  abi.filter((item) => item.type === type).map((item) => item.name)

describe('the bindings', () => {
  it("sign the authorization in the token's own EIP-712 domain", () => {
    const domain = { ...chain.tokenDomain, chainId: chain.chainId, verifyingContract: chain.token }
    expect(domainSeparator({ domain })).toBe(vectors.deployment.tokenDomainSeparator)
  })

  it('name the contract source they were generated from, which is the source in the repository', () => {
    const source = readFileSync(`${import.meta.dirname}/../../../${sidequestOperatorSource.path}`)
    const digest = createHash('sha256').update(source).digest('hex')
    // A different digest means `contracts/src` changed: run `bun tools/settlement-bindings.ts`.
    expect(digest).toBe(sidequestOperatorSource.sha256)
    expect(vectors.source.sha256).toBe(sidequestOperatorSource.sha256)
  })

  it("hold the operator's transitions and events, and the escrow parts settlement reads", () => {
    expect(names(sidequestOperatorAbi, 'event')).toEqual(
      expect.arrayContaining(['JobDelivered', 'JobFunded', 'JobRejected', 'JobSettled']),
    )
    expect(names(sidequestOperatorAbi, 'function')).toEqual(
      expect.arrayContaining([
        'fund',
        'deliver',
        'approve',
        'settleAfterReview',
        'reject',
        'rule',
        'settleUnruled',
        'refundUndelivered',
        'getJob',
      ]),
    )
    expect(names(authCaptureEscrowAbi, 'function')).toEqual(['getHash', 'paymentState'])
    expect(Schema.is(Hex32)(vectors.deployment.tokenDomainSeparator)).toBe(true)
  })
})
