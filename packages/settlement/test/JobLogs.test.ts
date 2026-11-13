import { it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import { type Hex, keccak256, toHex } from 'viem'
import { describe, expect } from 'vitest'
import { jobLogFact, jobLogsBetween, needsBlockTime } from '../src/JobLogs.ts'
import { maxLogRange } from '../src/LogScan.ts'
import { escrowLog, type FakeRpc, fakeRpc, operatorLog } from './FakeRpc.ts'
import { arbitrator, payer, receiver, vectorChain } from './fixtures.ts'

// Every job's operator logs and escrow reclaims, read as plain facts without an agreement to check them against.

const chain = vectorChain
const payment: Hex = `0x${'cd'.repeat(32)}`
const job: Hex = `0x${'ab'.repeat(32)}`
const digest: Hex = `0x${'9f'.repeat(32)}`
const deliveryHash = keccak256(toHex('logo.zip'))

const funded = {
  paymentInfoHash: payment,
  jobId: job,
  termsDigest: digest,
  payer,
  receiver,
  token: chain.token,
  amount: 250_000_000n,
  deliveryDeadline: 1_798_761_600,
  reviewWindow: 86_400,
  disputeWindow: 86_400,
  arbitrationWindow: 172_800,
  arbitrator,
  authorizationExpiry: 1_799_193_600,
}

/** Reads `from` to `to` as the index's poller does: the logs, then each one's fact. */
const factsBetween = (rpc: FakeRpc, from: bigint, to: bigint) =>
  Effect.map(jobLogsBetween(rpc.client, chain, from, to), (logs) =>
    logs.flatMap((log) => Option.toArray(jobLogFact(chain, log, needsBlockTime(chain, log) ? 1_799_300_000 : 0))),
  )

describe('reading every job’s logs', () => {
  it.effect('reads the operator’s job events and the escrow’s reclaim as facts, whatever payment they are about', () =>
    Effect.gen(function* () {
      const rpc = fakeRpc()
      rpc.emit(10n, chain.operator, operatorLog('JobFunded', funded), `0x${'01'.repeat(32)}`)
      rpc.emit(
        11n,
        chain.operator,
        operatorLog('JobDelivered', {
          paymentInfoHash: payment,
          termsDigest: digest,
          deliveryHash,
          deliveredAt: 1_798_000_000,
          reviewDeadline: 1_798_086_400,
        }),
      )
      rpc.emit(
        12n,
        chain.operator,
        operatorLog('JobSettled', {
          paymentInfoHash: payment,
          termsDigest: digest,
          outcome: 1,
          workerShareBps: 10_000,
          capturedAmount: 250_000_000n,
          feeAmount: 12_500_000n,
          refundedAmount: 0n,
          settledAt: 1_798_100_000,
        }),
      )
      rpc.emit(13n, chain.escrow, escrowLog('PaymentReclaimed', { paymentInfoHash: payment, amount: 250_000_000n }))
      // The same event from a contract that is not the operator is no fact.
      rpc.emit(14n, '0x00000000000000000000000000000000000bad00', operatorLog('JobFunded', funded))
      rpc.head = 20n
      const facts = yield* factsBetween(rpc, 0n, 20n)
      expect(facts.map(({ _tag }) => _tag)).toEqual(['Funded', 'Delivered', 'Settled', 'Reclaimed'])
      expect(facts[0]).toEqual({
        _tag: 'Funded',
        at: { block: 10, logIndex: 0 },
        transactionHash: `0x${'01'.repeat(32)}`,
        paymentHash: payment,
        job: 'ab'.repeat(32),
        termsDigest: '9f'.repeat(32),
        payer: `${chain.asset.network}:${payer}`,
        receiver: `${chain.asset.network}:${receiver}`,
        asset: chain.asset.id,
        amount: '250000000',
        deliveryDeadline: 1_798_761_600,
        reviewWindowSeconds: 86_400,
        disputeWindowSeconds: 86_400,
        arbitrationWindowSeconds: 172_800,
        arbitrator: `${chain.asset.network}:${arbitrator}`,
        authorizationExpiry: 1_799_193_600,
      })
      expect(facts[1]).toMatchObject({ deliveryHash, deliveredAt: 1_798_000_000, reviewEndsAt: 1_798_086_400 })
      expect(facts[2]).toMatchObject({ outcome: 'Approved', workerShareBps: 10_000, feeAmount: '12500000' })
      expect(facts[3]).toMatchObject({ amount: '250000000', reclaimedAt: 1_799_300_000, at: { block: 13 } })
    }),
  )

  it.effect('reads a delegated delivery as its `JobDelivered`, and a revoked delegation as nothing', () =>
    Effect.gen(function* () {
      const rpc = fakeRpc()
      const agent = '0x000000000000000000000000000000000000a6e7'
      rpc.emit(
        11n,
        chain.operator,
        operatorLog('JobDelivered', {
          paymentInfoHash: payment,
          termsDigest: digest,
          deliveryHash,
          deliveredAt: 1_798_000_000,
          reviewDeadline: 1_798_086_400,
        }),
      )
      rpc.emit(
        11n,
        chain.operator,
        operatorLog('JobDeliveryDelegated', {
          paymentInfoHash: payment,
          delegate: agent,
          delegationExpiry: 1_798_100_000,
        }),
      )
      rpc.emit(
        12n,
        chain.operator,
        operatorLog('DeliveryDelegateRevoked', { paymentInfoHash: payment, receiver, delegate: agent }),
      )
      rpc.head = 20n
      const facts = yield* factsBetween(rpc, 0n, 20n)
      expect(facts).toEqual([expect.objectContaining({ _tag: 'Delivered', deliveryHash, paymentHash: payment })])
    }),
  )

  it.effect('asks for ranges an RPC accepts', () =>
    Effect.gen(function* () {
      const rpc = fakeRpc()
      rpc.emit(maxLogRange + 3n, chain.operator, operatorLog('JobFunded', funded))
      rpc.head = maxLogRange * 2n
      const facts = yield* factsBetween(rpc, 0n, maxLogRange * 2n)
      expect(facts.map(({ at }) => at.block)).toEqual([Number(maxLogRange) + 3])
      expect(rpc.asked.filter((method) => method === 'eth_getLogs')).toHaveLength(3)
    }),
  )

  it.effect('reads a settlement claiming no outcome as no fact', () =>
    Effect.gen(function* () {
      const rpc = fakeRpc()
      rpc.emit(
        5n,
        chain.operator,
        operatorLog('JobSettled', {
          paymentInfoHash: payment,
          termsDigest: digest,
          outcome: 0,
          workerShareBps: 0,
          capturedAmount: 0n,
          feeAmount: 0n,
          refundedAmount: 0n,
          settledAt: 1,
        }),
      )
      rpc.head = 5n
      expect(yield* factsBetween(rpc, 0n, 5n)).toEqual([])
    }),
  )
})
