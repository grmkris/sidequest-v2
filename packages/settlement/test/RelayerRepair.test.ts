import { it } from '@effect/vitest'
import { Effect, Layer, Option, Redacted } from 'effect'
import { TestClock } from 'effect/testing'
import { decodeFunctionData, type Hex, isHex, keccak256, parseTransaction, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect } from 'vitest'
import { sidequestOperatorAbi } from '../src/abi/SidequestOperator.ts'
import { ChainRpc } from '../src/ChainRpc.ts'
import type { OperatorCall } from '../src/OperatorCall.ts'
import { termsPaymentOf } from '../src/Payment.ts'
import { SettlementStoreError } from '../src/RelayerIntents.ts'
import { memoryRelayerIntents, RelayerIntents, type RelayIntent } from '../src/RelayerIntents.ts'
import { CallReverted, Relayer, type RepairPolicy } from '../src/Relayer.ts'
import { type FakeRpc, fakeRpc, type Transaction } from './FakeRpc.ts'
import { signedTerms, payer, receiver, vectorChain } from './fixtures.ts'

// The relayer's nonce repair against the fake chain. A nonce the chain never uses holds up every later transaction
// from the key, so each case ends with the gap closed: the stuck nonce used by exactly one transaction of its intent,
// and the next intent mined behind it. Every relay below builds a fresh relayer over the same intents, as each request
// to the Worker does, so each one is also a restart.

const key = Redacted.make(keccak256(toHex('relayer')))
const relayerAddress = privateKeyToAccount(Redacted.value(key)).address.toLowerCase()
const operator = vectorChain.operator.toLowerCase()
const policy: RepairPolicy = { stuckAfterMillis: 60_000, maxReplacements: 2, bumpPercent: 25 }
const payment = Effect.runSync(termsPaymentOf(signedTerms(), { payer, receiver }, vectorChain))
const settleAfterReview: OperatorCall = { function: 'settleAfterReview', info: payment.info }
const refundUndelivered: OperatorCall = { function: 'refundUndelivered', info: payment.info }
const settleUnruled: OperatorCall = { function: 'settleUnruled', info: payment.info }

const layer = (rpc: FakeRpc, intents: RelayerIntents['Service']) =>
  Relayer.layer(key, vectorChain, policy).pipe(
    Layer.provide(Layer.mergeAll(Layer.succeed(ChainRpc, rpc.client), Layer.succeed(RelayerIntents, intents))),
  )
const relay = (rpc: FakeRpc, intents: RelayerIntents['Service'], id: string, call: OperatorCall) =>
  Effect.flatMap(Relayer, (relayer) => relayer.relay(id, call)).pipe(Effect.provide(layer(rpc, intents)))
const repair = (rpc: FakeRpc, intents: RelayerIntents['Service']) =>
  Effect.flatMap(Relayer, (relayer) => relayer.repair).pipe(Effect.provide(layer(rpc, intents)))

/** The transactions the chain holds at `nonce`, pending or mined. */
const at = (rpc: FakeRpc, nonce: number) => [...rpc.transactions.values()].filter((held) => held.nonce === nonce)
const only = (rpc: FakeRpc, nonce: number): Transaction => {
  const [held, ...more] = at(rpc, nonce)
  if (held === undefined || more.length > 0) throw new Error(`Not one transaction at nonce ${nonce}`)
  return held
}
const hashOf = (held: Transaction): Hex => keccak256(held.raw)
const functionOf = (held: Transaction) =>
  decodeFunctionData({ abi: sidequestOperatorAbi, data: parseTransaction(held.raw).data ?? '0x' }).functionName
const stored = (intents: RelayerIntents['Service'], id: string) =>
  Effect.map(intents.find(id), (found) => Option.getOrThrowWith(found, () => new Error(`No intent ${id}`)))
/** Why a relay was refused, or that it was not. */
const reasonOf = (error: unknown) => (error instanceof CallReverted ? error.reason : 'not refused')

/** A store that fails one write as if the Worker stopped: before it is made, or right after. */
const crashing = (
  intents: RelayerIntents['Service'],
  write: 'record' | 'close',
  when: 'before' | 'after',
): RelayerIntents['Service'] => {
  let armed = true
  const crash = <A>(effect: Effect.Effect<A, SettlementStoreError>) => {
    if (!armed) return effect
    armed = false
    const stop = Effect.fail(new SettlementStoreError({ store: 'crashed' }))
    return when === 'before' ? stop : Effect.andThen(effect, stop)
  }
  return {
    ...intents,
    record: (id, nonce, transaction) =>
      write === 'record' ? crash(intents.record(id, nonce, transaction)) : intents.record(id, nonce, transaction),
    close: (id, nonce, closing) =>
      write === 'close' ? crash(intents.close(id, nonce, closing)) : intents.close(id, nonce, closing),
  }
}

describe('the relayer repairs a nonce gap', () => {
  it.effect('signs a dropped call again at its nonce with higher fees, and the next intent goes through', () =>
    Effect.gen(function* () {
      const rpc = fakeRpc()
      const intents = memoryRelayerIntents()
      yield* relay(rpc, intents, 'a', settleAfterReview)
      const dropped = only(rpc, 0)
      yield* relay(rpc, intents, 'b', refundUndelivered)
      rpc.transactions.delete(hashOf(dropped))

      // Too soon to call it stuck: the same bytes go out again.
      yield* repair(rpc, intents)
      expect(hashOf(only(rpc, 0))).toBe(hashOf(dropped))
      rpc.transactions.delete(hashOf(dropped))
      yield* TestClock.adjust('61 seconds')
      yield* repair(rpc, intents)

      const replacement = only(rpc, 0)
      expect(hashOf(replacement)).not.toBe(hashOf(dropped))
      expect(replacement.to).toBe(operator)
      expect(parseTransaction(replacement.raw).data).toBe(parseTransaction(dropped.raw).data)
      expect(replacement.maxFeePerGas * 100n).toBeGreaterThanOrEqual(dropped.maxFeePerGas * 125n)
      expect(replacement.maxPriorityFeePerGas * 100n).toBeGreaterThanOrEqual(dropped.maxPriorityFeePerGas * 125n)

      rpc.mine(hashOf(replacement))
      rpc.mine(hashOf(only(rpc, 1)))
      const answered = yield* relay(rpc, intents, 'a', settleAfterReview)
      expect(answered.transactionHash).toBe(hashOf(replacement))
      expect(yield* stored(intents, 'a')).toMatchObject({ state: 'mined', outcome: hashOf(replacement), reason: null })
      expect(yield* stored(intents, 'b')).toMatchObject({ state: 'mined', nonce: 1 })
    }),
  )

  it.effect('replaces an underpriced call that sits in the mempool, and never sends a second call for it', () =>
    Effect.gen(function* () {
      const rpc = fakeRpc()
      const intents = memoryRelayerIntents()
      const first = yield* relay(rpc, intents, 'a', settleAfterReview)
      yield* TestClock.adjust('61 seconds')
      const second = yield* relay(rpc, intents, 'a', settleAfterReview)
      // The node took the replacement in place of the first: one transaction at the nonce, the call, priced higher.
      const replacement = only(rpc, 0)
      expect(second.transactionHash).toBe(hashOf(replacement))
      expect(second.transactionHash).not.toBe(first.transactionHash)
      expect(functionOf(replacement)).toBe('settleAfterReview')
      yield* TestClock.adjust('61 seconds')
      yield* relay(rpc, intents, 'a', settleAfterReview)
      yield* TestClock.adjust('61 seconds')
      // Past the replacements the policy allows: the nonce is released rather than bid up for ever.
      const given = yield* Effect.flip(relay(rpc, intents, 'a', settleAfterReview))
      expect(given).toMatchObject({ _tag: 'CallReverted', reason: 'Released: NotMined' })
      expect(only(rpc, 0).to).toBe(relayerAddress)
      expect((yield* stored(intents, 'a')).transactions.map(({ kind }) => kind)).toEqual([
        'call',
        'call',
        'call',
        'release',
      ])
    }),
  )

  it.effect('raises the fees of a call the node refuses as underpriced until it is accepted', () =>
    Effect.gen(function* () {
      const rpc = fakeRpc()
      const intents = memoryRelayerIntents()
      // The fake chain estimates 2.2 gwei; this node wants 3.
      const floor = 3_000_000_000n
      rpc.refuse = (held) => (held.maxFeePerGas < floor ? 'transaction underpriced' : undefined)
      const relayed = yield* relay(rpc, intents, 'a', settleAfterReview)
      const accepted = only(rpc, 0)
      expect(relayed.transactionHash).toBe(hashOf(accepted))
      expect(accepted.maxFeePerGas).toBeGreaterThanOrEqual(floor)
      expect(functionOf(accepted)).toBe('settleAfterReview')
      const refusals = (yield* stored(intents, 'a')).transactions.flatMap(({ refused }) =>
        refused === null ? [] : [refused],
      )
      expect(refusals).toEqual(['transaction underpriced', 'transaction underpriced'])
    }),
  )

  it.effect('releases the nonce of a call the node refuses for good, and lets the next intent through', () =>
    Effect.gen(function* () {
      const rpc = fakeRpc()
      const intents = memoryRelayerIntents()
      rpc.refuse = (held) => (held.to === operator ? 'rejected by policy' : undefined)
      const refused = yield* Effect.flip(relay(rpc, intents, 'a', settleAfterReview))
      expect(refused).toMatchObject({
        _tag: 'CallReverted',
        function: 'settleAfterReview',
        reason: 'Released: Refused: rejected by policy',
      })
      const release = only(rpc, 0)
      expect(release.to).toBe(relayerAddress)
      expect(parseTransaction(release.raw).value ?? 0n).toBe(0n)
      expect(parseTransaction(release.raw).gas).toBe(21_000n)

      rpc.refuse = () => undefined
      yield* relay(rpc, intents, 'b', refundUndelivered)
      rpc.mine(hashOf(release))
      rpc.mine(hashOf(only(rpc, 1)))
      yield* repair(rpc, intents)
      expect(yield* stored(intents, 'a')).toMatchObject({
        state: 'released',
        outcome: hashOf(release),
        reason: 'Refused: rejected by policy',
      })
      expect(yield* stored(intents, 'b')).toMatchObject({ state: 'mined' })

      // Its release is mined, so its call can never be mined at nonce 0: asked again, it takes a fresh nonce.
      const retried = yield* relay(rpc, intents, 'a', settleAfterReview)
      const call = only(rpc, 2)
      expect(retried.transactionHash).toBe(hashOf(call))
      expect(functionOf(call)).toBe('settleAfterReview')
      expect(at(rpc, 0).map(({ to }) => to)).toEqual([relayerAddress])
    }),
  )

  it.effect('releases a reserved nonce whose call reverts by the time it is signed, and records why', () =>
    Effect.gen(function* () {
      const rpc = fakeRpc()
      const intents = memoryRelayerIntents()
      // The Worker stops after reserving the nonce and before recording what it signed.
      const crashed = yield* Effect.flip(relay(rpc, crashing(intents, 'record', 'before'), 'a', settleAfterReview))
      expect(crashed).toMatchObject({ _tag: 'SettlementStoreError' })
      expect(rpc.transactions.size).toBe(0)
      // Meanwhile somebody else settled the job: the call now reverts.
      rpc.revert = 'WrongStatus'
      yield* repair(rpc, intents)
      const release = only(rpc, 0)
      expect(release.to).toBe(relayerAddress)
      rpc.mine(hashOf(release))
      // Asked again while the call still reverts, it is refused before it takes another nonce.
      expect(reasonOf(yield* Effect.flip(relay(rpc, intents, 'a', settleAfterReview)))).toMatch(/WrongStatus/)
      const released = yield* stored(intents, 'a')
      expect(released.state).toBe('released')
      expect(released.reason).toMatch(/^Reverts: .*WrongStatus/)
      rpc.revert = undefined
      yield* relay(rpc, intents, 'b', refundUndelivered)
      expect(functionOf(only(rpc, 1))).toBe('refundUndelivered')
    }),
  )

  it.effect('releases the nonce of a pending call that has come to revert', () =>
    Effect.gen(function* () {
      const rpc = fakeRpc()
      const intents = memoryRelayerIntents()
      yield* relay(rpc, intents, 'a', settleAfterReview)
      rpc.revert = 'WrongStatus'
      yield* TestClock.adjust('61 seconds')
      expect(reasonOf(yield* Effect.flip(relay(rpc, intents, 'a', settleAfterReview)))).toMatch(
        /^Released: Reverts: .*WrongStatus/,
      )
      expect(only(rpc, 0).to).toBe(relayerAddress)
    }),
  )

  it.effect('answers a call that was mined but reverted as refused, and keeps its nonce used', () =>
    Effect.gen(function* () {
      const rpc = fakeRpc()
      const intents = memoryRelayerIntents()
      const sent = yield* relay(rpc, intents, 'a', settleAfterReview)
      rpc.mine(sent.transactionHash, { reverted: true })
      expect(yield* Effect.flip(relay(rpc, intents, 'a', settleAfterReview))).toMatchObject({
        _tag: 'CallReverted',
        reason: 'RevertedOnChain',
      })
      yield* relay(rpc, intents, 'b', refundUndelivered)
      expect(only(rpc, 1).to).toBe(operator)
    }),
  )

  it.effect('closes an intent whose nonce the key used elsewhere, once it is too late for a lagging receipt', () =>
    Effect.gen(function* () {
      const rpc = fakeRpc()
      const intents = memoryRelayerIntents()
      yield* relay(rpc, intents, 'a', settleAfterReview)
      rpc.transactions.clear()
      rpc.usedElsewhere = 1
      expect(yield* Effect.flip(relay(rpc, intents, 'a', settleAfterReview))).toMatchObject({
        _tag: 'ChainUnavailable',
      })
      yield* TestClock.adjust('61 seconds')
      yield* repair(rpc, intents)
      expect(yield* stored(intents, 'a')).toMatchObject({ state: 'released', reason: 'NonceUsedElsewhere' })
      // Its call was never mined, and its nonce is gone: asked again, it takes the next one.
      const retried = yield* relay(rpc, intents, 'a', settleAfterReview)
      expect(retried.transactionHash).toBe(hashOf(only(rpc, 1)))
    }),
  )
})

describe('the relayer stays safe when relays race', () => {
  it.effect('two relays of one intent send one transaction', () =>
    Effect.gen(function* () {
      const rpc = fakeRpc()
      const intents = memoryRelayerIntents()
      const [one, two] = yield* Effect.all(
        [relay(rpc, intents, 'a', settleAfterReview), relay(rpc, intents, 'a', settleAfterReview)],
        { concurrency: 'unbounded' },
      )
      expect(one).toEqual(two)
      expect(rpc.transactions.size).toBe(1)
    }),
  )

  it.effect('two relays of two intents take two nonces', () =>
    Effect.gen(function* () {
      const rpc = fakeRpc()
      const intents = memoryRelayerIntents()
      yield* Effect.all(
        [
          relay(rpc, intents, 'a', settleAfterReview),
          relay(rpc, intents, 'b', refundUndelivered),
          relay(rpc, intents, 'c', settleUnruled),
        ],
        { concurrency: 'unbounded' },
      )
      expect([...rpc.transactions.values()].map(({ nonce }) => nonce).toSorted((a, b) => a - b)).toEqual([0, 1, 2])
    }),
  )

  it.effect('two relayers repairing one stuck intent sign one replacement between them', () =>
    Effect.gen(function* () {
      const rpc = fakeRpc()
      const intents = memoryRelayerIntents()
      yield* relay(rpc, intents, 'a', settleAfterReview)
      yield* TestClock.adjust('61 seconds')
      yield* Effect.all([repair(rpc, intents), repair(rpc, intents)], { concurrency: 'unbounded' })
      expect((yield* stored(intents, 'a')).transactions).toHaveLength(2)
      expect(at(rpc, 0)).toHaveLength(1)
    }),
  )

  it.effect('a repair racing a release and a relay never lets two calls of one intent be mined', () =>
    Effect.gen(function* () {
      const rpc = fakeRpc()
      const intents = memoryRelayerIntents()
      rpc.refuse = (held) => (held.to === operator ? 'rejected by policy' : undefined)
      yield* Effect.all(
        [
          Effect.flip(relay(rpc, intents, 'a', settleAfterReview)),
          repair(rpc, intents),
          Effect.flip(relay(rpc, intents, 'a', settleAfterReview)),
        ],
        { concurrency: 'unbounded' },
      )
      rpc.refuse = () => undefined
      const [release] = at(rpc, 0)
      if (release === undefined) throw new Error('Nothing at nonce 0')
      rpc.mine(hashOf(release))
      const intent: RelayIntent = yield* stored(intents, 'a')
      // Every transaction the intent signed holds nonce 0; the chain mined one, the release.
      expect(intent.transactions.every(({ raw }) => isHex(raw) && parseTransaction(raw).nonce === 0)).toBe(true)
      expect(release.to).toBe(relayerAddress)
    }),
  )
})

describe('the relayer carries on after a restart in the middle of each step', () => {
  it.effect('after reserving, before signing: the next relay signs and sends the call at the reserved nonce', () =>
    Effect.gen(function* () {
      const rpc = fakeRpc()
      const intents = memoryRelayerIntents()
      yield* Effect.flip(relay(rpc, crashing(intents, 'record', 'before'), 'a', settleAfterReview))
      const sent = yield* relay(rpc, intents, 'a', settleAfterReview)
      expect(sent.transactionHash).toBe(hashOf(only(rpc, 0)))
      expect(functionOf(only(rpc, 0))).toBe('settleAfterReview')
    }),
  )

  it.effect('after recording a signed call, before sending it: the next relay sends the same bytes', () =>
    Effect.gen(function* () {
      const rpc = fakeRpc()
      const intents = memoryRelayerIntents()
      yield* Effect.flip(relay(rpc, crashing(intents, 'record', 'after'), 'a', settleAfterReview))
      expect(rpc.transactions.size).toBe(0)
      const [signed] = (yield* stored(intents, 'a')).transactions
      const sent = yield* relay(rpc, intents, 'a', settleAfterReview)
      expect(sent.transactionHash).toBe(signed?.hash)
      expect(rpc.transactions.size).toBe(1)
    }),
  )

  it.effect('after the connection broke while sending: the next relay sends the same bytes', () =>
    Effect.gen(function* () {
      const rpc = fakeRpc()
      const intents = memoryRelayerIntents()
      rpc.failNextSend = true
      expect(yield* Effect.flip(relay(rpc, intents, 'a', settleAfterReview))).toMatchObject({
        _tag: 'ChainUnavailable',
      })
      const [signed] = (yield* stored(intents, 'a')).transactions
      const sent = yield* relay(rpc, intents, 'a', settleAfterReview)
      expect(sent.transactionHash).toBe(signed?.hash)
    }),
  )

  it.effect('after recording a replacement, before sending it: the next relay sends the replacement', () =>
    Effect.gen(function* () {
      const rpc = fakeRpc()
      const intents = memoryRelayerIntents()
      const first = yield* relay(rpc, intents, 'a', settleAfterReview)
      yield* TestClock.adjust('61 seconds')
      rpc.failNextSend = true
      yield* Effect.flip(repair(rpc, intents))
      expect(hashOf(only(rpc, 0))).toBe(first.transactionHash)
      const replacement = (yield* stored(intents, 'a')).transactions.at(-1)
      const sent = yield* relay(rpc, intents, 'a', settleAfterReview)
      expect(sent.transactionHash).toBe(replacement?.hash)
      expect(hashOf(only(rpc, 0))).toBe(replacement?.hash)
    }),
  )

  it.effect('after a release is mined, before the intent is closed: the next relay closes it as released', () =>
    Effect.gen(function* () {
      const rpc = fakeRpc()
      const intents = memoryRelayerIntents()
      rpc.refuse = (held) => (held.to === operator ? 'rejected by policy' : undefined)
      yield* Effect.flip(relay(rpc, intents, 'a', settleAfterReview))
      rpc.mine(hashOf(only(rpc, 0)))
      yield* Effect.flip(repair(rpc, crashing(intents, 'close', 'before')))
      expect(yield* stored(intents, 'a')).toMatchObject({ state: 'open' })
      yield* repair(rpc, intents)
      expect(yield* stored(intents, 'a')).toMatchObject({ state: 'released', reason: 'Refused: rejected by policy' })
    }),
  )
})
