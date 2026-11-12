import { it } from '@effect/vitest'
import { Effect, Layer, Option, Redacted } from 'effect'
import { decodeFunctionData, keccak256, parseTransaction, toHex } from 'viem'
import { describe, expect } from 'vitest'
import { sidequestOperatorAbi } from '../src/abi/SidequestOperator.ts'
import { ChainRpc } from '../src/ChainRpc.ts'
import type { OperatorCall } from '../src/OperatorCall.ts'
import { paymentOf } from '../src/Payment.ts'
import { memoryRelayerIntents, RelayerIntents } from '../src/RelayerIntents.ts'
import { Relayer } from '../src/Relayer.ts'
import { type FakeRpc, fakeRpc } from './FakeRpc.ts'
import { agreement, payer, receiver, vectorChain } from './fixtures.ts'

const key = Redacted.make(keccak256(toHex('relayer')))
const payment = Effect.runSync(paymentOf(agreement(), { payer, receiver }, vectorChain))
const settleAfterReview: OperatorCall = { function: 'settleAfterReview', info: payment.info }
const refundUndelivered: OperatorCall = { function: 'refundUndelivered', info: payment.info }

/** A relayer over `rpc`, with `intents` surviving across the relayers a test builds, as D1 does across requests. */
const relayer = (rpc: FakeRpc, intents = memoryRelayerIntents()) =>
  Relayer.layer(key, vectorChain).pipe(
    Layer.provide(Layer.mergeAll(Layer.succeed(ChainRpc, rpc.client), Layer.succeed(RelayerIntents, intents))),
  )

const relay = (rpc: FakeRpc, intents: RelayerIntents['Service'], id: string, call: OperatorCall) =>
  Effect.flatMap(Relayer, (service) => service.relay(id, call)).pipe(Effect.provide(relayer(rpc, intents)))

const sends = (rpc: FakeRpc) => rpc.asked.filter((method) => method === 'eth_sendRawTransaction').length

describe('the relayer', () => {
  it.effect('sends the call to the operator, and nowhere else, from its own key', () =>
    Effect.gen(function* () {
      const rpc = fakeRpc()
      const sent = yield* relay(rpc, memoryRelayerIntents(), 'job-1:settleAfterReview', settleAfterReview)
      const [raw] = [...rpc.transactions.values()].map((transaction) => transaction.raw)
      if (raw === undefined) throw new Error('Nothing was sent')
      const transaction = parseTransaction(raw)
      expect(transaction.to?.toLowerCase()).toBe(vectorChain.operator.toLowerCase())
      expect(transaction.chainId).toBe(vectorChain.chainId)
      expect(transaction.nonce).toBe(0)
      const { functionName } = decodeFunctionData({ abi: sidequestOperatorAbi, data: transaction.data ?? '0x' })
      expect(functionName).toBe('settleAfterReview')
      expect(sent.transactionHash).toBe(keccak256(raw))
    }),
  )

  it.effect('after a lost response, finds its transaction on the retry and does not send it twice', () =>
    Effect.gen(function* () {
      const rpc = fakeRpc()
      const intents = memoryRelayerIntents()
      rpc.dropNextResponse = true
      const lost = yield* Effect.flip(relay(rpc, intents, 'job-1:settleAfterReview', settleAfterReview))
      expect(lost).toMatchObject({ _tag: 'ChainUnavailable' })
      const retried = yield* relay(rpc, intents, 'job-1:settleAfterReview', settleAfterReview)
      expect(sends(rpc)).toBe(1)
      expect(rpc.transactions.has(retried.transactionHash)).toBe(true)
    }),
  )

  it.effect('begun twice under one id, relays once and answers the same transaction', () =>
    Effect.gen(function* () {
      const rpc = fakeRpc()
      const intents = memoryRelayerIntents()
      const first = yield* relay(rpc, intents, 'job-1:settleAfterReview', settleAfterReview)
      const second = yield* relay(rpc, intents, 'job-1:settleAfterReview', settleAfterReview)
      expect(second).toEqual(first)
      expect(sends(rpc)).toBe(1)
    }),
  )

  it.effect('refuses a different call under an id it has relayed', () =>
    Effect.gen(function* () {
      const rpc = fakeRpc()
      const intents = memoryRelayerIntents()
      yield* relay(rpc, intents, 'job-1:deadline', settleAfterReview)
      const changed = yield* Effect.flip(relay(rpc, intents, 'job-1:deadline', refundUndelivered))
      expect(changed).toMatchObject({ _tag: 'IntentConflict', id: 'job-1:deadline' })
      expect(sends(rpc)).toBe(1)
    }),
  )

  it.effect('broadcasts the same signed bytes again when the chain lost the transaction', () =>
    Effect.gen(function* () {
      const rpc = fakeRpc()
      const intents = memoryRelayerIntents()
      const first = yield* relay(rpc, intents, 'job-1:settleAfterReview', settleAfterReview)
      rpc.transactions.delete(first.transactionHash)
      const again = yield* relay(rpc, intents, 'job-1:settleAfterReview', settleAfterReview)
      expect(again.transactionHash).toBe(first.transactionHash)
      expect(sends(rpc)).toBe(2)
    }),
  )

  it.effect('refuses a call the chain would revert before it takes a nonce', () =>
    Effect.gen(function* () {
      const rpc = fakeRpc()
      const intents = memoryRelayerIntents()
      rpc.revert = 'TooEarly'
      const refused = yield* Effect.flip(relay(rpc, intents, 'job-1:settleAfterReview', settleAfterReview))
      expect(refused).toMatchObject({ _tag: 'CallReverted', function: 'settleAfterReview' })
      rpc.revert = undefined
      yield* relay(rpc, intents, 'job-2:refundUndelivered', refundUndelivered)
      const [raw] = [...rpc.transactions.values()].map((transaction) => transaction.raw)
      expect(raw === undefined ? undefined : parseTransaction(raw).nonce).toBe(0)
    }),
  )

  it.effect('gives two intents two nonces even when the chain has not seen the first yet', () =>
    Effect.gen(function* () {
      const rpc = fakeRpc()
      const intents = memoryRelayerIntents()
      yield* relay(rpc, intents, 'job-1:settleAfterReview', settleAfterReview)
      rpc.nonce = 0 // a lagging node still counts no transaction from the relayer
      yield* relay(rpc, intents, 'job-2:refundUndelivered', refundUndelivered)
      const nonces = [...rpc.transactions.values()].map(({ raw }) => parseTransaction(raw).nonce)
      expect(nonces).toEqual([0, 1])
    }),
  )

  it.effect('closes an intent the chain mined without sending its transaction again', () =>
    Effect.gen(function* () {
      const rpc = fakeRpc()
      const intents = memoryRelayerIntents()
      const funded = yield* relay(rpc, intents, 'job-1:settleAfterReview', settleAfterReview)
      rpc.mine(funded.transactionHash)
      // As a node, or the gate rehearsal's proxy, may: refuse a transaction it is sent again, whatever became of it.
      rpc.refuse = (transaction) => (keccak256(transaction.raw) === funded.transactionHash ? 'withheld' : undefined)
      yield* relay(rpc, intents, 'job-2:refundUndelivered', refundUndelivered)
      // The next relay closes the mined intent first; it sends only its own call.
      expect(sends(rpc)).toBe(2)
      const closed = yield* intents.find('job-1:settleAfterReview')
      expect(closed.pipe(Option.map(({ state, transactions }) => [state, transactions.at(-1)?.refused]))).toEqual(
        Option.some(['mined', null]),
      )
    }),
  )
})
