import { it } from '@effect/vitest'
import { Effect, Layer, Option, Redacted } from 'effect'
import { decodeFunctionData, getAddress, keccak256, parseTransaction, toHex } from 'viem'
import { describe, expect } from 'vitest'
import { sidequestOperatorAbi } from '../src/abi/SidequestOperator.ts'
import { ChainRpc } from '../src/ChainRpc.ts'
import { EscrowAdapter } from '../src/EscrowAdapter.ts'
import { PaymentAdapter, paymentRequestId } from '../src/PaymentAdapter.ts'
import { memoryPaymentRequests, PaymentRequests } from '../src/PaymentRequests.ts'
import { memoryRelayerIntents, RelayerIntents } from '../src/RelayerIntents.ts'
import { Relayer } from '../src/Relayer.ts'
import { type FakeRpc, fakeRpc } from './FakeRpc.ts'
import { agreement, payer, receiver, vectorChain } from './fixtures.ts'

const other = getAddress('0x00000000000000000000000000000000000c0ffe')
const id = paymentRequestId(agreement())
const authorization = `0x${'ab'.repeat(65)}` as const

const adapter = (rpc: FakeRpc) =>
  EscrowAdapter(vectorChain).pipe(
    Layer.provideMerge(Relayer.layer(Redacted.make(keccak256(toHex('relayer'))), vectorChain)),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ChainRpc, rpc.client),
        Layer.succeed(PaymentRequests, memoryPaymentRequests()),
        Layer.succeed(RelayerIntents, memoryRelayerIntents()),
      ),
    ),
  )

const withAdapter = <A, E>(rpc: FakeRpc, use: (escrow: PaymentAdapter['Service']) => Effect.Effect<A, E>) =>
  Effect.flatMap(PaymentAdapter, use).pipe(Effect.provide(adapter(rpc)))

describe('the escrow adapter', () => {
  it.effect('answers the same request to sign however often it is begun, and keeps the block to read from', () => {
    const rpc = fakeRpc()
    rpc.head = 40n
    return withAdapter(rpc, (escrow) =>
      Effect.gen(function* () {
        const first = yield* escrow.begin({ id, agreement: agreement(), payer, receiver })
        rpc.head = 50n
        const again = yield* escrow.begin({ id, agreement: agreement(), payer, receiver })
        expect(again).toEqual(first)
        expect(first).toMatchObject({ state: 'begun', payer, receiver, amount: '250000000', feeBps: 500 })
        expect(first.typedData).toMatchObject({
          primaryType: 'ReceiveWithAuthorization',
          message: { from: payer, to: vectorChain.collector, value: '250000000', validAfter: '0' },
        })
        const record = yield* escrow.lookup(id)
        expect(Option.map(record, ({ fromBlock }) => fromBlock)).toEqual(Option.some('40'))
      }),
    )
  })

  it.effect('refuses other parties under an open request, and accepts them once it is cancelled', () =>
    withAdapter(fakeRpc(), (escrow) =>
      Effect.gen(function* () {
        yield* escrow.begin({ id, agreement: agreement(), payer, receiver })
        const changed = yield* Effect.flip(escrow.begin({ id, agreement: agreement(), payer: other, receiver }))
        expect(changed).toMatchObject({ _tag: 'ParametersChanged' })
        yield* escrow.cancel(id)
        const replaced = yield* escrow.begin({ id, agreement: agreement(), payer: other, receiver })
        expect(replaced.payer).toBe(other)
      }),
    ),
  )

  it.effect('relays fund with the authorization it was given, and then can neither change nor cancel', () => {
    const rpc = fakeRpc()
    return withAdapter(rpc, (escrow) =>
      Effect.gen(function* () {
        const notBegun = yield* Effect.flip(escrow.submit(id, agreement(), authorization))
        expect(notBegun).toMatchObject({ _tag: 'NotBegun' })
        const asked = yield* escrow.begin({ id, agreement: agreement(), payer, receiver })
        const before = rpc.asked.length
        yield* escrow.lookup(id)
        expect(rpc.asked).toHaveLength(before)
        const relayed = yield* escrow.submit(id, agreement(), authorization)
        const [raw] = [...rpc.transactions.values()].map((transaction) => transaction.raw)
        const call = decodeFunctionData({
          abi: sidequestOperatorAbi,
          data: raw === undefined ? '0x' : (parseTransaction(raw).data ?? '0x'),
        })
        expect(call.functionName).toBe('fund')
        expect(call.args?.[2]).toBe(authorization)
        expect(yield* escrow.lookup(id)).toEqual(
          Option.some(
            expect.objectContaining({
              state: 'submitted',
              transactionHash: relayed.transactionHash,
              paymentHash: asked.paymentHash,
            }),
          ),
        )
        const changed = yield* Effect.flip(escrow.begin({ id, agreement: agreement(), payer: other, receiver }))
        expect(changed).toMatchObject({ _tag: 'AlreadySubmitted' })
        const cancelled = yield* Effect.flip(escrow.cancel(id))
        expect(cancelled).toMatchObject({ _tag: 'AlreadySubmitted' })
      }),
    )
  })
})
