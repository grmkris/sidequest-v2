import { it } from '@effect/vitest'
import { Effect, Option, Schema } from 'effect'
import { describe, expect } from 'vitest'
import { type ChainLog, ChainFacts, chainFactLimits } from '../src/Index/ChainFacts.ts'
import { alice, bob, indexWorld } from './IndexWorld.ts'
import {
  deliveredFact,
  fundedFact,
  onArc,
  proposalBy,
  releasedFact,
  requestBy,
  termsFrom,
  walletOfKey,
} from './JobWorld.ts'

const at = 1_800_000_000
const offered = termsFrom(at)
const request = await requestBy(alice, at)
const other = await requestBy(alice, at + 1, undefined, 'Another job')
const proposal = await proposalBy(bob, request, at + 1, offered)
const otherProposal = await proposalBy(bob, other, at + 1, offered)

// A job's funding, delivery and release; a second funding of the same job on another payment, later; and another
// job's funding. Each in its own transaction.
const facts: ReadonlyArray<ChainLog> = [
  onArc(fundedFact(proposal, walletOfKey(alice), 100, offered), '01'),
  onArc(deliveredFact(120, at + 100, `0x${'de'.repeat(32)}`), '02'),
  onArc(releasedFact(130, at + 200), '03'),
  onArc(fundedFact(proposal, walletOfKey(alice), 140, offered, 'ce'), '04'),
  onArc(fundedFact(otherProposal, walletOfKey(alice), 150, offered, 'cf'), '05'),
  onArc(deliveredFact(160, at + 300, `0x${'df'.repeat(32)}`, 'cf'), '06'),
  onArc(deliveredFact(170, at + 400, `0x${'df'.repeat(32)}`, 'ce'), '07'),
]

const table = (sqlite: ReturnType<typeof indexWorld>['sqlite']) =>
  sqlite.prepare('SELECT * FROM chain_facts ORDER BY chain, tx_hash, log_index').all()

const recorded = (logs: ReadonlyArray<ChainLog>) => {
  const { sqlite, layer } = indexWorld()
  return Effect.gen(function* () {
    const chainFacts = yield* ChainFacts
    yield* chainFacts.record(logs)
    return { rows: table(sqlite), forJob: yield* chainFacts.forJob(request.id) }
  }).pipe(Effect.provide(layer))
}

describe('the chain facts the index records', () => {
  it.effect('are one row per log: recording again changes nothing', () =>
    Effect.gen(function* () {
      const once = yield* recorded(facts)
      expect(once.rows).toHaveLength(facts.length)
      expect(yield* recorded([...facts, ...facts])).toEqual(once)
    }),
  )

  it.effect.prop(
    'are the same for any order the logs were recorded in',
    [Schema.Array(Schema.Int).check(Schema.isBetweenLength(facts.length, facts.length))],
    ([keys]) =>
      Effect.gen(function* () {
        const order = facts.map((fact, index) => ({ fact, key: keys[index] ?? 0 })).toSorted((a, b) => a.key - b.key)
        expect(yield* recorded(order.map(({ fact }) => fact))).toEqual(yield* recorded(facts))
      }),
    { arbitrary: { runs: 20 } },
  )

  it.effect('answer a job its fundings, earliest first, and the later facts of its earliest funding’s payment', () =>
    Effect.gen(function* () {
      const { forJob } = yield* recorded(facts.toReversed())
      expect(forJob).toMatchObject([
        { _tag: 'Funded', at: { block: 100 } },
        { _tag: 'Funded', at: { block: 140 } },
        { _tag: 'Delivered', at: { block: 120 } },
        { _tag: 'Settled', at: { block: 130 } },
      ])
    }),
  )

  it.effect('bound a job’s fundings, keeping the earliest', () =>
    Effect.gen(function* () {
      const many = Array.from({ length: chainFactLimits.fundings + 5 }, (_, index) =>
        onArc(
          fundedFact(proposal, walletOfKey(alice), 1_000 - index, offered, (16 + index).toString(16)),
          (16 + index).toString(16),
        ),
      )
      const { forJob } = yield* recorded(many)
      expect(forJob).toHaveLength(chainFactLimits.fundings)
      expect(forJob[0]?.at.block).toBe(1_000 - chainFactLimits.fundings - 4)
    }),
  )

  it.effect('move the poller’s cursor forward only', () =>
    Effect.gen(function* () {
      const chainFacts = yield* ChainFacts
      expect(yield* chainFacts.scannedTo('eip155:1')).toEqual(Option.none())
      yield* chainFacts.advance('eip155:1', 50)
      yield* chainFacts.advance('eip155:1', 40)
      expect(yield* chainFacts.scannedTo('eip155:1')).toEqual(Option.some(50))
    }).pipe(Effect.provide(indexWorld().layer)),
  )
})
