import { it } from '@effect/vitest'
import { Amount, NetworkRef } from '@sidequest/protocol'
import { Cause, Effect, Exit, Option, Schema } from 'effect'
import { describe, expect } from 'vitest'
import { termsPaymentOf, type UnpayableTerms } from '../src/Payment.ts'
import { signedTerms, arbitrator, payer, receiver, vectorChain, vectors } from './fixtures.ts'

const parties = { payer, receiver }
const margin = vectors.deployment.margin // the operator's MARGIN, as the contract reports it
const hour = 60 * 60
const day = 24 * hour
const maxUint48 = 2 ** 48 - 1

const refusal = (exit: Exit.Exit<unknown, UnpayableTerms>) =>
  Exit.isFailure(exit) ? Option.toArray(Option.map(Cause.findErrorOption(exit.cause), (error) => error.reason)) : []

describe('the payment for a job’s signed terms', () => {
  it.effect('is the payment the escrow hashes to the typical vector', () =>
    Effect.gen(function* () {
      const payment = yield* termsPaymentOf(signedTerms(), parties, vectorChain)
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
        const { info } = yield* termsPaymentOf(signedTerms(terms), parties, vectorChain)
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
      const { info } = yield* termsPaymentOf(signedTerms({ amount: Amount.make(largest) }), parties, vectorChain)
      expect(info.maxAmount).toBe(2n ** 120n - 1n)
      const over = yield* Effect.exit(
        termsPaymentOf(signedTerms({ amount: Amount.make((2n ** 120n).toString()) }), parties, vectorChain),
      )
      expect(refusal(over)).toEqual(['amount'])
    }),
  )

  it.effect('reaches the last expiry a uint48 holds, and refuses a deadline one second later', () =>
    Effect.gen(function* () {
      const windowsAndMargin = 3 * day + 2 * day + 7 * day + margin
      const latest = maxUint48 - windowsAndMargin
      const { info } = yield* termsPaymentOf(signedTerms({ deliveryDeadline: latest }), parties, vectorChain)
      expect(info.authorizationExpiry).toBe(maxUint48)
      const late = yield* Effect.exit(
        termsPaymentOf(signedTerms({ deliveryDeadline: latest + 1 }), parties, vectorChain),
      )
      expect(refusal(late)).toEqual(['deadline'])
    }),
  )

  it.effect('refuses another network or asset, and an arbitrator who is a party', () =>
    Effect.gen(function* () {
      const elsewhere = { ...vectorChain, asset: { ...vectorChain.asset, network: NetworkRef.make('eip155:1') } }
      const otherNetwork = yield* Effect.exit(termsPaymentOf(signedTerms(), parties, elsewhere))
      expect(refusal(otherNetwork)).toEqual(['network'])
      const ownArbitrator = yield* Effect.exit(
        termsPaymentOf(signedTerms(), { payer: arbitrator, receiver }, vectorChain),
      )
      expect(refusal(ownArbitrator)).toEqual(['arbitrator'])
      const paidArbitrator = yield* Effect.exit(
        termsPaymentOf(signedTerms(), { payer, receiver: arbitrator }, vectorChain),
      )
      expect(refusal(paidArbitrator)).toEqual(['arbitrator'])
    }),
  )
})
