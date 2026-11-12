import { it } from '@effect/vitest'
import { Amount, JobId, NetworkRef } from '@sidequest/protocol'
import { Cause, Effect, Exit, Option, Schema } from 'effect'
import { describe, expect } from 'vitest'
import { paymentOf, type UnpayableAgreement } from '../src/Payment.ts'
import { jobIdWord } from '../src/Words.ts'
import { agreement, arbitrator, payer, receiver, vectorChain, vectors } from './fixtures.ts'

const parties = { payer, receiver }
const margin = vectors.deployment.margin // the operator's MARGIN, as the contract reports it
const hour = 60 * 60
const day = 24 * hour
const maxUint48 = 2 ** 48 - 1

const refusal = (exit: Exit.Exit<unknown, UnpayableAgreement>) =>
  Exit.isFailure(exit) ? Option.toArray(Option.map(Cause.findErrorOption(exit.cause), (error) => error.reason)) : []

describe('the payment for an agreement', () => {
  it.effect('is the payment the escrow hashes to the typical vector', () =>
    Effect.gen(function* () {
      const payment = yield* paymentOf(agreement(), parties, vectorChain)
      const [typical] = vectors.cases
      expect(payment.hash).toBe(typical?.paymentInfoHash)
      expect(payment.nonce).toBe(typical?.payerAgnosticHash)
      expect(payment.info).toMatchObject({
        operator: vectorChain.operator,
        payer,
        receiver,
        token: vectorChain.token,
        maxAmount: 250_000_000n,
        preApprovalExpiry: 1_798_761_600,
        minFeeBps: 500,
        maxFeeBps: 500,
        feeReceiver: vectorChain.feeReceiver,
      })
      expect(payment.params.arbitrator).toBe(arbitrator)
    }),
  )

  const windows = Schema.Struct({
    deliveryDeadline: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4_000_000_000 })),
    reviewWindowSeconds: Schema.Int.check(Schema.isBetween({ minimum: hour, maximum: 14 * day })),
    disputeWindowSeconds: Schema.Int.check(Schema.isBetween({ minimum: hour, maximum: 14 * day })),
    arbitrationWindowSeconds: Schema.Int.check(Schema.isBetween({ minimum: 12 * hour, maximum: 14 * day })),
  })

  it.effect.prop(
    'expires exactly at the earliest instant fund accepts, after every window, and lets funding lapse at the deadline',
    [windows],
    ([terms]) =>
      Effect.gen(function* () {
        const { info } = yield* paymentOf(agreement(terms), parties, vectorChain)
        const lastWindowEnds =
          terms.deliveryDeadline +
          terms.reviewWindowSeconds +
          terms.disputeWindowSeconds +
          terms.arbitrationWindowSeconds
        expect(info.authorizationExpiry).toBe(lastWindowEnds + margin)
        expect(info.refundExpiry).toBe(info.authorizationExpiry)
        expect(info.preApprovalExpiry).toBe(terms.deliveryDeadline)
      }),
  )

  it.effect('carries the largest amount the escrow holds, and refuses one unit more', () =>
    Effect.gen(function* () {
      const largest = (2n ** 120n - 1n).toString()
      const { info } = yield* paymentOf(agreement({ amount: Amount.make(largest) }), parties, vectorChain)
      expect(info.maxAmount).toBe(2n ** 120n - 1n)
      const over = yield* Effect.exit(
        paymentOf(agreement({ amount: Amount.make((2n ** 120n).toString()) }), parties, vectorChain),
      )
      expect(refusal(over)).toEqual(['amount'])
    }),
  )

  it.effect('reaches the last expiry a uint48 holds, and refuses a deadline one second later', () =>
    Effect.gen(function* () {
      const windowsAndMargin = 3 * day + 2 * day + 7 * day + margin
      const latest = maxUint48 - windowsAndMargin
      const { info } = yield* paymentOf(agreement({ deliveryDeadline: latest }), parties, vectorChain)
      expect(info.authorizationExpiry).toBe(maxUint48)
      const late = yield* Effect.exit(paymentOf(agreement({ deliveryDeadline: latest + 1 }), parties, vectorChain))
      expect(refusal(late)).toEqual(['deadline'])
    }),
  )

  it.effect('refuses another network or asset, and an arbitrator who is a party', () =>
    Effect.gen(function* () {
      const elsewhere = { ...vectorChain, asset: { ...vectorChain.asset, network: NetworkRef.make('eip155:1') } }
      const otherNetwork = yield* Effect.exit(paymentOf(agreement(), parties, elsewhere))
      expect(refusal(otherNetwork)).toEqual(['network'])
      const ownArbitrator = yield* Effect.exit(paymentOf(agreement(), { payer: arbitrator, receiver }, vectorChain))
      expect(refusal(ownArbitrator)).toEqual(['arbitrator'])
      const paidArbitrator = yield* Effect.exit(paymentOf(agreement(), { payer, receiver: arbitrator }, vectorChain))
      expect(refusal(paidArbitrator)).toEqual(['arbitrator'])
    }),
  )
})

describe('a job id on chain', () => {
  it.effect('is the 128 bits of its ULID, from all zeros to all ones', () =>
    Effect.sync(() => {
      expect(jobIdWord(JobId.make('job_00000000000000000000000000'))).toBe(`0x${'0'.repeat(64)}`)
      expect(jobIdWord(JobId.make('job_7ZZZZZZZZZZZZZZZZZZZZZZZZZ'))).toBe(`0x${'0'.repeat(32)}${'f'.repeat(32)}`)
      // Crockford base32: 1 is 1, A is 10, Z is 31.
      expect(jobIdWord(JobId.make('job_0000000000000000000000001A'))).toBe(
        `0x${(32 + 10).toString(16).padStart(64, '0')}`,
      )
    }),
  )

  it.prop('names one job only', [JobId, JobId], ([a, b]) => a === b || jobIdWord(a) !== jobIdWord(b))
})
