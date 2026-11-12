import { it } from '@effect/vitest'
import { memoryRelayerIntents, RelayerIntents, type RelayTransaction } from '@sidequest/settlement/RelayerIntents'
import { Effect, Layer, Match, Schema } from 'effect'
import { describe, expect } from 'vitest'
import { D1RelayerIntents } from '../src/Settlement/D1SettlementStores.ts'
import { localSql } from './LocalSql.ts'

// The relayer's D1 store against the memory store, the model its port describes: any history of reservations,
// recorded and refused transactions, closings and reopenings leaves both answering the same. The relayer's own tests
// run on the memory store, so this is what carries them over to D1.

const signer = '0x00000000000000000000000000000000000000aa'
const ids = ['fund:1', 'approval:1', 'refund:2'] as const
const Which = Schema.Literals([0, 1, 2])
const Small = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 }))

const Step = Schema.Union([
  Schema.TaggedStruct('Reserve', { which: Which, minimumNonce: Small }),
  Schema.TaggedStruct('Record', {
    which: Which,
    nonce: Small,
    sequence: Small,
    kind: Schema.Literals(['call', 'release']),
    tag: Small,
  }),
  Schema.TaggedStruct('Refuse', { which: Which, tag: Small, nonce: Small, sequence: Small }),
  Schema.TaggedStruct('Close', { which: Which, nonce: Small, mined: Schema.Boolean }),
  Schema.TaggedStruct('Reopen', { which: Which, minimumNonce: Small }),
])
type Step = typeof Step.Type

/** One transaction per intent, nonce, sequence and tag, so a step names the same bytes in both stores. */
const transaction = (which: number, nonce: number, sequence: number, kind: 'call' | 'release', tag: number) => {
  const hash = `0x${[which, nonce, sequence, tag].map((part) => part.toString(16).padStart(16, '0')).join('')}`
  const signed: RelayTransaction = {
    hash,
    sequence,
    kind,
    raw: `0x02${hash.slice(2)}`,
    maxFeePerGas: String(2_000_000_000 + tag),
    maxPriorityFeePerGas: '1000000000',
    signedAt: 1_800_000_000_000 + sequence,
    reason: sequence === 0 ? null : 'NotMined',
    refused: null,
  }
  return signed
}

const apply = (store: RelayerIntents['Service'], step: Step) =>
  Match.valueTags(step, {
    Reserve: ({ which, minimumNonce }) =>
      store.reserve({ id: ids[which], signer, to: '0xoperator', data: `0x${which}`, minimumNonce }),
    Record: ({ which, nonce, sequence, kind, tag }) =>
      store.record(ids[which], nonce, transaction(which, nonce, sequence, kind, tag)),
    Refuse: ({ which, nonce, sequence, tag }) =>
      store.refused(transaction(which, nonce, sequence, 'call', tag).hash, 'underpriced'),
    Close: ({ which, nonce, mined }) =>
      store.close(ids[which], nonce, {
        state: mined ? 'mined' : 'released',
        outcome: `0x${nonce}`,
        reason: mined ? null : 'Refused: underpriced',
      }),
    Reopen: ({ which, minimumNonce }) => store.reopen(ids[which], minimumNonce),
  })

/** What a write answered, or that it failed. */
const outcome = <A, E>(write: Effect.Effect<A, E>) =>
  write.pipe(
    Effect.map((value) => ({ answered: value })),
    Effect.catch(() => Effect.succeed('failed' as const)),
  )

describe('D1RelayerIntents', () => {
  it.effect.prop('answers what the memory store answers after any history of relays', [Schema.Array(Step)], ([steps]) =>
    Effect.gen(function* () {
      const d1 = yield* RelayerIntents
      const model = memoryRelayerIntents()
      for (const step of steps) {
        // A write to an intent nobody reserved fails in both, and changes nothing.
        const [stored, expected] = yield* Effect.all([outcome(apply(d1, step)), outcome(apply(model, step))])
        expect(stored).toEqual(expected)
        for (const id of ids) expect(yield* d1.find(id)).toEqual(yield* model.find(id))
        expect(yield* d1.open(signer)).toEqual(yield* model.open(signer))
      }
    }).pipe(Effect.provide(D1RelayerIntents.pipe(Layer.provide(localSql().layer)))),
  )

  it.effect('records one transaction at a sequence when two relays race for it', () =>
    Effect.gen(function* () {
      const store = yield* RelayerIntents
      yield* store.reserve({ id: ids[0], signer, to: '0xoperator', data: '0x0', minimumNonce: 3 })
      const first = transaction(0, 3, 0, 'call', 1)
      const second = transaction(0, 3, 0, 'call', 2)
      yield* store.record(ids[0], 3, first)
      const after = yield* store.record(ids[0], 3, second)
      expect(after.transactions.map(({ hash }) => hash)).toEqual([first.hash])
    }).pipe(Effect.provide(D1RelayerIntents.pipe(Layer.provide(localSql().layer)))),
  )

  it.effect('gives a reopened intent a nonce above every other the signer holds', () =>
    Effect.gen(function* () {
      const store = yield* RelayerIntents
      yield* store.reserve({ id: ids[0], signer, to: '0xoperator', data: '0x0', minimumNonce: 0 })
      yield* store.reserve({ id: ids[1], signer, to: '0xoperator', data: '0x1', minimumNonce: 0 })
      yield* store.close(ids[0], 0, { state: 'released', outcome: '0xr', reason: 'Refused: underpriced' })
      const reopened = yield* store.reopen(ids[0], 0)
      expect(reopened).toMatchObject({ nonce: 2, state: 'open', outcome: null, reason: null, transactions: [] })
    }).pipe(Effect.provide(D1RelayerIntents.pipe(Layer.provide(localSql().layer)))),
  )
})
