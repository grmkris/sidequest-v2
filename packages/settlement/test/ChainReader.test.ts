import { it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { type Address, type Hex, keccak256, toHex } from 'viem'
import { describe, expect } from 'vitest'
import { readEscrow } from '../src/ChainReader.ts'
import { ChainRpc } from '../src/ChainRpc.ts'
import type { Expected } from '../src/Expected.ts'
import { type Payment, paymentOf } from '../src/Payment.ts'
import { memoryReaderCursors, ReaderCursors } from '../src/ReaderCursors.ts'
import { escrowLog, type FakeRpc, fakeRpc, operatorLog } from './FakeRpc.ts'
import { agreement, payer, receiver, vectorChain } from './fixtures.ts'

const chain = vectorChain // three confirmations
const deliveryHash = keccak256(toHex('logo.zip'))

const expectedFor = (payment: Payment): Expected => ({ agreement: agreement(), payment, chain, fromBlock: 5n })

const fundedArgs = (payment: Payment) => ({
  paymentInfoHash: payment.hash,
  jobId: payment.params.jobId,
  termsDigest: payment.params.termsDigest,
  payer: payment.info.payer,
  receiver: payment.info.receiver,
  token: payment.info.token,
  amount: payment.info.maxAmount,
  deliveryDeadline: payment.params.deliveryDeadline,
  reviewWindow: payment.params.reviewWindow,
  disputeWindow: payment.params.disputeWindow,
  arbitrationWindow: payment.params.arbitrationWindow,
  arbitrator: payment.params.arbitrator,
  authorizationExpiry: payment.info.authorizationExpiry,
})

/** Read the escrow for the typical agreement over `rpc`, with fresh or given cursors. */
const read = (rpc: FakeRpc, cursors = memoryReaderCursors()) =>
  Effect.gen(function* () {
    const payment = yield* paymentOf(agreement(), { payer, receiver }, chain)
    return yield* readEscrow(expectedFor(payment))
  }).pipe(Effect.provide(Layer.mergeAll(Layer.succeed(ChainRpc, rpc.client), Layer.succeed(ReaderCursors, cursors))))

const typicalPayment = Effect.runSync(paymentOf(agreement(), { payer, receiver }, chain))

const fund = (rpc: FakeRpc, block: bigint, args: Partial<ReturnType<typeof fundedArgs>> = {}) => {
  rpc.emit(block, chain.operator, operatorLog('JobFunded', { ...fundedArgs(typicalPayment), ...args }))
  rpc.statuses.set(block, 1)
}

const deliver = (
  rpc: FakeRpc,
  block: bigint,
  deliveredAt = 1_798_000_000,
  reviewDeadline = deliveredAt + 3 * 86_400,
) => {
  rpc.emit(
    block,
    chain.operator,
    operatorLog('JobDelivered', {
      paymentInfoHash: typicalPayment.hash,
      termsDigest: typicalPayment.params.termsDigest,
      deliveryHash,
      deliveredAt,
      reviewDeadline,
    }),
  )
  rpc.statuses.set(block, 2)
}

const settle = (
  rpc: FakeRpc,
  block: bigint,
  args: { outcome: number; share: number; captured: bigint; fee: bigint; refunded: bigint },
) => {
  rpc.emit(
    block,
    chain.operator,
    operatorLog('JobSettled', {
      paymentInfoHash: typicalPayment.hash,
      termsDigest: typicalPayment.params.termsDigest,
      outcome: args.outcome,
      workerShareBps: args.share,
      capturedAmount: args.captured,
      feeAmount: args.fee,
      refundedAmount: args.refunded,
      settledAt: 1_798_500_000,
    }),
  )
  rpc.statuses.set(block, 4)
}

describe('the chain reader', () => {
  it.effect('reports funding once three blocks confirm it, with every field from the agreement', () =>
    Effect.gen(function* () {
      const rpc = fakeRpc()
      fund(rpc, 10n)
      rpc.head = 11n
      const early = yield* read(rpc)
      expect(early).toMatchObject({ stage: 'Unfunded', funding: null, problems: [] })
      rpc.head = 12n
      const confirmed = yield* read(rpc)
      expect(confirmed.stage).toBe('Funded')
      expect(confirmed.chainTime).toBe(1_800_000_010)
      expect(confirmed.funding).toMatchObject({
        job: agreement().job,
        operation: 'authorize',
        amount: '250000000',
        asset: chain.asset.id,
        payer: `${chain.asset.network}:${payer}`,
        payee: `${chain.asset.network}:${receiver}`,
        paymentHash: typicalPayment.hash,
        status: 'success',
        confirmations: 3,
      })
    }),
  )

  const other: Address = '0x00000000000000000000000000000000000bad00'
  const otherWord: Hex = `0x${'ab'.repeat(32)}`
  const fundingMismatches = [
    ['jobId', { jobId: otherWord }],
    ['termsDigest', { termsDigest: otherWord }],
    ['payer', { payer: other }],
    ['receiver', { receiver: other }],
    ['token', { token: other }],
    ['amount', { amount: 249_999_999n }],
    ['deliveryDeadline', { deliveryDeadline: 1_798_761_601 }],
    ['reviewWindow', { reviewWindow: 3 * 86_400 + 1 }],
    ['disputeWindow', { disputeWindow: 2 * 86_400 - 1 }],
    ['arbitrationWindow', { arbitrationWindow: 8 * 86_400 }],
    ['arbitrator', { arbitrator: other }],
    ['authorizationExpiry', { authorizationExpiry: typicalPayment.info.authorizationExpiry + 1 }],
  ] as const
  for (const [field, change] of fundingMismatches)
    it.effect(`counts a funding whose ${field} differs as a receipt mismatch, never as funded`, () =>
      Effect.gen(function* () {
        const rpc = fakeRpc()
        fund(rpc, 10n, change)
        rpc.head = 20n
        const status = yield* read(rpc)
        expect(status.stage).toBe('Unfunded')
        expect(status.problems).toContainEqual(
          expect.objectContaining({ event: 'JobFunded', kind: 'receipt_mismatch', field }),
        )
      }),
    )

  it.effect('counts a log it cannot read, or one without its transaction, as inconclusive', () =>
    Effect.gen(function* () {
      const rpc = fakeRpc()
      const log = operatorLog('JobFunded', fundedArgs(typicalPayment))
      rpc.emit(10n, chain.operator, { topics: log.topics, data: '0x1234' })
      rpc.emit(11n, chain.operator, log, null)
      rpc.statuses.set(11n, 1)
      rpc.head = 20n
      const status = yield* read(rpc)
      expect(status.stage).toBe('Unfunded')
      expect(status.problems).toEqual([
        expect.objectContaining({ kind: 'inconclusive', field: 'log' }),
        expect.objectContaining({ kind: 'inconclusive', field: 'transactionHash' }),
        expect.objectContaining({ event: 'getJob', kind: 'inconclusive', field: 'status', expected: 'Funded' }),
      ])
    }),
  )

  it.effect('never reports an event a reorganisation removed before it reached the depth', () =>
    Effect.gen(function* () {
      const rpc = fakeRpc()
      const cursors = memoryReaderCursors()
      fund(rpc, 10n)
      rpc.head = 11n
      expect((yield* read(rpc, cursors)).stage).toBe('Unfunded')
      // Block 10 is replaced by one without the funding; the chain moves on past the depth.
      rpc.blocks.delete(10n)
      rpc.statuses.delete(10n)
      rpc.head = 30n
      expect(yield* read(rpc, cursors)).toMatchObject({ stage: 'Unfunded', problems: [] })
    }),
  )

  it.effect('reads each block range once: later reads scan only the blocks confirmed since', () =>
    Effect.gen(function* () {
      const rpc = fakeRpc()
      const cursors = memoryReaderCursors()
      fund(rpc, 10n)
      rpc.head = 12n
      expect((yield* read(rpc, cursors)).stage).toBe('Funded')
      deliver(rpc, 20n)
      rpc.head = 22n
      const delivered = yield* read(rpc, cursors)
      expect(delivered.stage).toBe('Delivered')
      expect(delivered.delivery).toMatchObject({
        deliveryHash: deliveryHash.slice(2),
        reviewEndsAt: 1_798_000_000 + 3 * 86_400,
      })
      expect(rpc.asked.filter((method) => method === 'eth_getLogs')).toHaveLength(2)
    }),
  )

  it.effect('refuses a delivery whose review deadline is not the agreed window after it', () =>
    Effect.gen(function* () {
      const rpc = fakeRpc()
      fund(rpc, 10n)
      deliver(rpc, 11n, 1_798_000_000, 1_798_000_000 + 86_400)
      rpc.head = 20n
      const status = yield* read(rpc)
      expect(status.stage).toBe('Funded')
      expect(status.problems).toContainEqual(
        expect.objectContaining({ field: 'reviewDeadline', kind: 'receipt_mismatch' }),
      )
    }),
  )

  it.effect('reports a ruled split as a capture of the share and a void of the rest, fee included', () =>
    Effect.gen(function* () {
      const rpc = fakeRpc()
      fund(rpc, 10n)
      deliver(rpc, 11n)
      rpc.emit(
        12n,
        chain.operator,
        operatorLog('JobRejected', {
          paymentInfoHash: typicalPayment.hash,
          termsDigest: typicalPayment.params.termsDigest,
          rejectedAt: 1_798_100_000,
          arbitrationDeadline: 1_798_100_000 + 9 * 86_400,
        }),
      )
      settle(rpc, 13n, { outcome: 3, share: 6000, captured: 150_000_000n, fee: 7_500_000n, refunded: 100_000_000n })
      rpc.head = 20n
      const status = yield* read(rpc)
      expect(status.stage).toBe('Settled')
      expect(status.rejection).toMatchObject({ rejectedAt: 1_798_100_000 })
      expect(status.settlement).toMatchObject({
        outcome: 'Ruled',
        workerShareBps: 6000,
        receipts: [
          { operation: 'capture', amount: '150000000' },
          { operation: 'void', amount: '100000000' },
        ],
      })
    }),
  )

  const settlementMismatches = [
    [
      'a capture of the wrong amount',
      { outcome: 1, share: 10_000, captured: 250_000_001n, fee: 12_500_000n, refunded: 0n },
      'capturedAmount',
    ],
    [
      'a fee off by one unit',
      { outcome: 1, share: 10_000, captured: 250_000_000n, fee: 12_500_001n, refunded: 0n },
      'feeAmount',
    ],
    [
      'an approval of less than everything',
      { outcome: 1, share: 9_000, captured: 225_000_000n, fee: 11_250_000n, refunded: 25_000_000n },
      'workerShareBps',
    ],
    ['an unknown outcome', { outcome: 9, share: 0, captured: 0n, fee: 0n, refunded: 250_000_000n }, 'outcome'],
  ] as const
  for (const [name, args, field] of settlementMismatches)
    it.effect(`refuses a settlement with ${name}`, () =>
      Effect.gen(function* () {
        const rpc = fakeRpc()
        fund(rpc, 10n)
        deliver(rpc, 11n)
        settle(rpc, 12n, args)
        rpc.head = 20n
        const status = yield* read(rpc)
        expect(status.stage).toBe('Delivered')
        expect(status.problems).toContainEqual(expect.objectContaining({ event: 'JobSettled', field }))
      }),
    )

  it.effect("reports the payer's reclaim from the escrow as a refund, though the operator's job stays put", () =>
    Effect.gen(function* () {
      const rpc = fakeRpc()
      fund(rpc, 10n)
      rpc.emit(
        15n,
        chain.escrow,
        escrowLog('PaymentReclaimed', { paymentInfoHash: typicalPayment.hash, amount: 250_000_000n }),
      )
      rpc.head = 20n
      const status = yield* read(rpc)
      expect(status).toMatchObject({ stage: 'Settled', problems: [] })
      expect(status.settlement).toMatchObject({
        outcome: 'Reclaimed',
        settledAt: 1_800_000_015,
        receipts: [{ operation: 'reclaim' }],
      })
    }),
  )

  it.effect('is unavailable, not unfunded, when the chain does not answer', () =>
    Effect.gen(function* () {
      const rpc = fakeRpc()
      rpc.down = true
      const failure = yield* Effect.flip(read(rpc))
      expect(failure).toMatchObject({ _tag: 'ChainUnavailable' })
    }),
  )
})
