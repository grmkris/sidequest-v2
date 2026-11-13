import { it } from '@effect/vitest'
import type { ChainFact } from '@sidequest/fold'
import type { NostrEvent } from '@sidequest/nostr'
import { Effect, Option } from 'effect'
import { describe, expect } from 'vitest'
import { ChainFacts } from '../src/Index/ChainFacts.ts'
import { Ingest } from '../src/Index/Ingest.ts'
import { keptTerms } from '../src/Native/KeptTerms.ts'
import { makeSettler, settlerLimits } from '../src/Native/Settler.ts'
import { alice, bob, indexWorld, walletOne } from './IndexWorld.ts'
import { onArc, proposalBy, requestBy, termsFrom } from './JobWorld.ts'
import { fakeChain, fundingOf, laterFact } from './NativeWorld.ts'

// The settler of Nostr-native jobs: from the chain's facts and the chain's time it relays the deadline call that is
// due, once, and only for jobs whose request event the index holds.

const at = 1_800_000_000
const day = 86_400
const terms = termsFrom(at)
const request = await requestBy(alice, at)
const proposal = await proposalBy(bob, request, at + 10, terms)
const { payment, fact: funded } = await fundingOf(proposal, terms, walletOne.address)
const deadline = terms.deliveryDeadline

/** The settler over an index holding `events` and `facts`, on a chain whose time is `clock.now`. */
const settling = (
  setup: {
    readonly events: ReadonlyArray<NostrEvent>
    readonly facts: ReadonlyArray<ChainFact>
    readonly reverts?: string
    readonly intents?: ReadonlyArray<readonly [string, string]>
  },
  clock: { now: number },
) => {
  const world = indexWorld()
  const { chain, sent } = fakeChain(world.sqlite, clock, setup.reverts)
  for (const [index, [id, state]] of (setup.intents ?? []).entries())
    world.sqlite
      .prepare(
        `INSERT INTO relayer_intents (id, signer, nonce, target, data, state) VALUES (?, 'other', ?, '0x', '0x', ?)`,
      )
      .run(id, index, state)
  const prepared = Effect.gen(function* () {
    const index = yield* Ingest
    yield* Effect.forEach(setup.events, (event) => index.ingest(event, 'publish'), { discard: true })
    yield* Effect.flatMap(ChainFacts, (facts) =>
      facts.record(setup.facts.map((fact, position) => onArc(fact, (16 + position).toString(16)))),
    )
    return yield* makeSettler(Option.some(chain))
  })
  return { prepared, sent, layer: world.layer, sqlite: world.sqlite }
}

/** Run the settler `times` times at `now`; what it sent and what each run said. */
const runAt = (
  now: number,
  facts: ReadonlyArray<ChainFact>,
  options: {
    events?: ReadonlyArray<NostrEvent>
    reverts?: string
    intents?: ReadonlyArray<readonly [string, string]>
    times?: number
  } = {},
) => {
  const world = settling({ events: options.events ?? [request, proposal], facts, ...options }, { now })
  return Effect.gen(function* () {
    const settler = yield* world.prepared
    const runs = []
    for (let run = 0; run < (options.times ?? 1); run += 1) runs.push(yield* settler.run)
    const kept = yield* Effect.flatMap(keptTerms, (store) => store.terms(request.id, null))
    return { runs, sent: world.sent, kept }
  }).pipe(Effect.provide(world.layer))
}

const callsOf = (sent: ReadonlyArray<{ readonly call: { readonly function: string } }>) =>
  sent.map(({ call }) => call.function)

describe('the settler', () => {
  it.effect('refunds a payment nothing was delivered for, once the chain’s time reaches the delivery deadline', () =>
    Effect.gen(function* () {
      expect(callsOf((yield* runAt(deadline - 1, [funded])).sent)).toEqual([])
      const { sent, runs } = yield* runAt(deadline, [funded])
      expect(sent).toEqual([
        {
          id: `refundUndelivered:${payment.hash}:native:0`,
          call: { function: 'refundUndelivered', info: payment.info },
        },
      ])
      expect(runs[0]).toMatchObject([{ result: 'sent', paymentHash: payment.hash }])
    }),
  )

  it.effect('settles a delivery nobody rejected once its review window has ended on chain', () =>
    Effect.gen(function* () {
      const delivered = laterFact(payment.hash, 'Delivered', at + day, 120)
      expect(callsOf((yield* runAt(at + 2 * day - 1, [funded, delivered])).sent)).toEqual([])
      // Past the delivery deadline too: a delivered payment is never refunded as undelivered.
      expect(callsOf((yield* runAt(deadline + day, [funded, delivered])).sent)).toEqual(['settleAfterReview'])
    }),
  )

  it.effect('refunds a dispute nobody ruled on once the arbitration window has ended on chain', () =>
    Effect.gen(function* () {
      const facts = [
        funded,
        laterFact(payment.hash, 'Delivered', at + day, 120),
        laterFact(payment.hash, 'Rejected', at + day + 60, 130),
      ]
      expect(callsOf((yield* runAt(at + day + 60 + 3 * day - 1, facts)).sent)).toEqual([])
      expect(callsOf((yield* runAt(at + day + 60 + 3 * day, facts)).sent)).toEqual(['settleUnruled'])
    }),
  )

  it.effect('sends a call once: a later run resumes its intent and sends nothing new', () =>
    Effect.gen(function* () {
      const { sent, runs } = yield* runAt(deadline, [funded], { times: 3 })
      expect(sent).toHaveLength(1)
      expect(runs.flat().map(({ result }) => result)).toEqual(['sent', 'sent', 'sent'])
    }),
  )

  it.effect('sends nothing while another call for the payment is in flight, or once its own call was mined', () =>
    Effect.gen(function* () {
      const pending = yield* runAt(deadline, [funded], { intents: [[`approval:${payment.hash}`, 'open']] })
      expect(pending.sent).toEqual([])
      expect(pending.runs[0]).toMatchObject([{ result: 'pending', intent: `approval:${payment.hash}` }])
      const mined = yield* runAt(deadline, [funded], {
        intents: [[`refundUndelivered:${payment.hash}:native:0`, 'mined']],
      })
      expect(mined.sent).toEqual([])
      expect(mined.runs[0]).toMatchObject([{ result: 'mined' }])
    }),
  )

  it.effect('tries again on a fresh intent after a released one, at most a few times', () =>
    Effect.gen(function* () {
      const once = yield* runAt(deadline, [funded], {
        intents: [[`refundUndelivered:${payment.hash}:native:0`, 'released']],
      })
      expect(once.sent.map(({ id }) => id)).toEqual([`refundUndelivered:${payment.hash}:native:1`])
      const spent = Array.from(
        { length: settlerLimits.attempts },
        (_, attempt) => [`refundUndelivered:${payment.hash}:native:${attempt}`, 'released'] as const,
      )
      const given = yield* runAt(deadline, [funded], { intents: spent })
      expect(given.sent).toEqual([])
      expect(given.runs[0]).toMatchObject([{ result: 'gaveUp' }])
    }),
  )

  it.effect('sends nothing for a call that reverts in simulation, and looks again next run', () =>
    Effect.gen(function* () {
      const { sent, runs } = yield* runAt(deadline, [funded], { reverts: 'TooEarly', times: 2 })
      expect(sent).toEqual([])
      expect(runs.flat()).toMatchObject([
        { result: 'reverted', reason: 'TooEarly' },
        { result: 'reverted', reason: 'TooEarly' },
      ])
    }),
  )

  it.effect('never acts on a payment whose job has no indexed request: that job is phase 1’s', () =>
    Effect.gen(function* () {
      const { sent, runs } = yield* runAt(deadline + 30 * day, [funded], { events: [proposal] })
      expect(sent).toEqual([])
      expect(runs[0]).toEqual([])
    }),
  )

  it.effect('leaves a payment that has ended alone', () =>
    Effect.map(runAt(deadline + 30 * day, [funded, laterFact(payment.hash, 'Settled', at + day, 140)]), ({ sent }) =>
      expect(sent).toEqual([]),
    ),
  )

  it.effect('keeps the request and the funded proposal of a funded job for good, verbatim', () =>
    Effect.gen(function* () {
      const other = yield* Effect.promise(() => proposalBy(bob, request, at + 20, termsFrom(at, '99000000')))
      const { kept } = yield* runAt(at, [funded], { events: [request, proposal, other] })
      expect(kept).toEqual(Option.some({ request, proposal }))
      const unfunded = yield* runAt(at, [], { events: [request, proposal] })
      expect(unfunded.kept).toEqual(Option.none())
    }),
  )
})
