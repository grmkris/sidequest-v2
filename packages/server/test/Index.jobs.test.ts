import { it } from '@effect/vitest'
import type { NostrEvent } from '@sidequest/nostr'
import type { Cursor } from '@sidequest/protocol'
import { Effect, Option } from 'effect'
import { TestClock } from 'effect/testing'
import { describe, expect } from 'vitest'
import { ChainFacts } from '../src/Index/ChainFacts.ts'
import { Ingest } from '../src/Index/Ingest.ts'
import { jobReadLimits } from '../src/Index/JobEvents.ts'
import { Jobs, openJobLimits } from '../src/Index/Jobs.ts'
import { alice, bob, carol, grant, indexWorld, keyOf, revocation } from './IndexWorld.ts'
import { acceptBy, fundedFact, onArc, proposalBy, requestBy, statementBy, termsFrom, walletOfKey } from './JobWorld.ts'

const at = 1_800_000_000
const promised = <A>(make: () => Promise<A>) => Effect.promise(make)
const ingest = (event: NostrEvent) => Effect.flatMap(Ingest, (index) => index.ingest(event, 'publish'))
const ingestAll = (events: ReadonlyArray<NostrEvent>) => Effect.forEach(events, ingest, { discard: true })
const inIndex = <A, E>(effect: Effect.Effect<A, E, Ingest | Jobs | ChainFacts>) =>
  Effect.provide(Effect.andThen(TestClock.setTime(at * 1000), effect), indexWorld().layer)

const stageOf = (id: string) =>
  Effect.map(
    Effect.flatMap(Jobs, (jobs) => jobs.job(id)),
    Option.map((view) => view.stage),
  )

/** Every open request, page by page. */
const allOpen = (hideExpired = false) =>
  Effect.gen(function* () {
    const jobs = yield* Jobs
    const found: Array<string> = []
    let cursor: Cursor | undefined
    for (let page = 0; page < 50; page += 1) {
      const answer = yield* jobs.open({ hideExpired, limit: 2, ...(cursor === undefined ? {} : { cursor }) })
      found.push(...answer.items.map(({ job }) => job))
      if (answer.next === null) return found
      cursor = answer.next
    }
    return found
  })

describe('the open requests', () => {
  it.effect('are exactly the jobs the fold finds open, proposed or accepted', () =>
    inIndex(
      Effect.gen(function* () {
        const requests = yield* promised(() =>
          Promise.all([
            requestBy(alice, at - 10, undefined, 'Open'),
            requestBy(alice, at - 9, undefined, 'Proposed'),
            requestBy(alice, at - 8, undefined, 'Accepted'),
            requestBy(alice, at - 7, undefined, 'Withdrawn by its buyer'),
            requestBy(alice, at - 6, undefined, 'Withdrawn by a stranger'),
            requestBy(carol, at - 5, undefined, 'Funded'),
            requestBy(carol, at - 4, undefined, 'A proposal withdrawn'),
            requestBy(carol, at - 3_600, 60, 'Expired'),
            requestBy(alice, at - 2, undefined, 'Withdrawn about itself'),
          ]),
        )
        const [opened, proposed, accepted, withdrawn, stranger, funded, aboutOther, expired, aboutItself] = requests
        if (
          opened === undefined ||
          proposed === undefined ||
          accepted === undefined ||
          withdrawn === undefined ||
          stranger === undefined ||
          funded === undefined ||
          aboutOther === undefined ||
          expired === undefined ||
          aboutItself === undefined
        )
          return yield* Effect.die('fixture')
        const offered = termsFrom(at)
        const bids = yield* promised(() =>
          Promise.all([proposed, accepted, funded, aboutOther].map((job) => proposalBy(bob, job, at, offered))),
        )
        const [, acceptedBid, fundedBid, otherBid] = bids
        if (acceptedBid === undefined || fundedBid === undefined || otherBid === undefined)
          return yield* Effect.die('fixture')
        const others = yield* promised(() =>
          Promise.all([
            acceptBy(alice, acceptedBid, at + 1),
            statementBy(alice, withdrawn.id, 'withdraw_request', at + 1),
            statementBy(bob, stranger.id, 'withdraw_request', at + 1),
            statementBy(carol, aboutOther.id, 'withdraw_request', at + 1, otherBid.id),
            statementBy(alice, aboutItself.id, 'withdraw_request', at + 1, aboutItself.id),
            // About the open request, but for another job: it closes neither.
            statementBy(alice, withdrawn.id, 'withdraw_request', at + 2, opened.id),
          ]),
        )
        yield* ingestAll([...requests, ...bids, ...others])
        yield* Effect.flatMap(ChainFacts, (facts) =>
          facts.record([onArc(fundedFact(fundedBid, walletOfKey(carol), 100, offered))]),
        )

        const stages = yield* Effect.forEach(requests, (request) => stageOf(request.id))
        expect(stages.map(Option.getOrNull)).toEqual([
          'open',
          'proposed',
          'accepted',
          'closed',
          'open',
          'funded',
          'proposed',
          'open',
          'closed',
        ])
        const live = new Set(['open', 'proposed', 'accepted'])
        const foldOpen = requests
          .filter((_, index) => Option.exists(stages[index] ?? Option.none(), (stage) => live.has(stage)))
          .toSorted((left, right) => right.created_at - left.created_at)
          .map(({ id }) => id)
        expect(yield* allOpen()).toEqual(foldOpen)
        expect(yield* allOpen(true)).toEqual(foldOpen.filter((id) => id !== expired.id))
        const page = yield* Effect.flatMap(Jobs, (jobs) => jobs.open({ hideExpired: false }))
        expect(page.items.map(({ request, proposals, expired: late }) => [request.title, proposals, late])).toEqual([
          ['A proposal withdrawn', 1, false],
          ['Withdrawn by a stranger', 0, false],
          ['Accepted', 1, false],
          ['Proposed', 1, false],
          ['Open', 0, false],
          ['Expired', 0, true],
        ])
        expect(page.items[0]?.buyer).toBe(aboutOther.pubkey)
      }),
    ),
  )

  it.effect('examine a bounded window per page: a page of nothing but closed requests still leads on', () =>
    inIndex(
      Effect.gen(function* () {
        const oldest = yield* promised(() => requestBy(bob, at - 1_000, undefined, 'Still open'))
        const closed = yield* promised(() =>
          Promise.all(Array.from({ length: openJobLimits.scan }, (_, index) => requestBy(alice, at + index))),
        )
        const withdrawals = yield* promised(() =>
          Promise.all(closed.map((request) => statementBy(alice, request.id, 'withdraw_request', at + 500))),
        )
        yield* ingestAll([oldest, ...closed, ...withdrawals])
        const jobs = yield* Jobs
        const first = yield* jobs.open({ hideExpired: false })
        expect(first.items).toEqual([])
        expect(first.next).not.toBeNull()
        const second = yield* jobs.open({ hideExpired: false, cursor: first.next ?? undefined })
        expect(second.items.map(({ job }) => job)).toEqual([oldest.id])
        expect(second.next).toBeNull()
      }),
    ),
  )
})

describe('a job read', () => {
  it.effect('folds a bounded number of events, and keeps the ones that decide the stage whatever the spam', () =>
    inIndex(
      Effect.gen(function* () {
        const request = yield* promised(() => requestBy(alice, at))
        const offered = termsFrom(at)
        const chosen = yield* promised(() => proposalBy(bob, request, at + 1, offered))
        const accept = yield* promised(() => acceptBy(alice, chosen, at + 2))
        const spam = yield* promised(() =>
          Promise.all(
            Array.from({ length: jobReadLimits.proposals + 10 }, (_, index) =>
              proposalBy(carol, request, at + 10 + index, termsFrom(at, String(1_000_000 + index))),
            ),
          ),
        )
        yield* ingestAll([request, chosen, accept, ...spam])
        const jobs = yield* Jobs
        const view = Option.getOrThrow(yield* jobs.job(request.id))
        expect(view.stage).toBe('accepted')
        expect(view.proposals.length).toBe(jobReadLimits.proposals + 1)
        expect(view.proposals.find(({ id }) => id === chosen.id)?.accepted).toBe(true)
        yield* Effect.flatMap(ChainFacts, (facts) =>
          facts.record([onArc(fundedFact(chosen, walletOfKey(alice), 100, offered))]),
        )
        const funded = Option.getOrThrow(yield* jobs.job(request.id))
        expect(funded).toMatchObject({ stage: 'funded', worker: chosen.pubkey, funding: { proposal: chosen.id } })
        expect(yield* jobs.job(chosen.id)).toEqual(Option.none())
        expect(yield* jobs.job('0'.repeat(64))).toEqual(Option.none())
      }),
    ),
  )
})

describe('a job read with agents', () => {
  const agent = keyOf('5'.repeat(64))
  const window = { createdAt: at - 60, notBefore: at - 60, expiresAt: at + 86_400 }

  it.effect('counts the buyer’s agent’s accept under their grant whatever the spam, and stops when it is revoked', () =>
    inIndex(
      Effect.gen(function* () {
        const accepting = grant(alice, agent, window, ['accept'])
        const request = yield* promised(() => requestBy(alice, at))
        const chosen = yield* promised(() => proposalBy(bob, request, at + 1, termsFrom(at)))
        const accept = yield* promised(() => acceptBy(agent, chosen, at + 2, accepting.id))
        const spam = yield* promised(() =>
          Promise.all(
            Array.from({ length: jobReadLimits.accepts + 5 }, (_, index) => acceptBy(carol, chosen, at + 10 + index)),
          ),
        )
        yield* ingestAll([accepting, request, chosen, accept, ...spam])
        const jobs = yield* Jobs
        const view = Option.getOrThrow(yield* jobs.job(request.id))
        expect(view.stage).toBe('accepted')
        expect(view.accepts.find(({ id }) => id === accept.id)).toMatchObject({
          by: 'agent',
          operator: request.pubkey,
          grant: accepting.id,
          fromBuyer: true,
        })
        yield* ingest(revocation(alice, accepting.id, at + 100))
        expect(yield* stageOf(request.id)).toEqual(Option.some('proposed'))
      }),
    ),
  )

  it.effect(
    'closes a request its buyer’s agent withdrew under their grant, in the read and in the open list alike',
    () =>
      inIndex(
        Effect.gen(function* () {
          const accepting = grant(alice, agent, window, ['accept'])
          const discussing = grant(carol, agent, window, ['discuss'])
          const closed = yield* promised(() => requestBy(alice, at, undefined, 'Closed by an agent'))
          const notClosed = yield* promised(() => requestBy(carol, at + 1, undefined, 'An agent without the scope'))
          const withdrawals = yield* promised(() =>
            Promise.all([
              statementBy(agent, closed.id, 'withdraw_request', at + 2, undefined, accepting.id),
              statementBy(agent, notClosed.id, 'withdraw_request', at + 2, undefined, discussing.id),
            ]),
          )
          yield* ingestAll([accepting, discussing, closed, notClosed, ...withdrawals])
          expect(yield* stageOf(closed.id)).toEqual(Option.some('closed'))
          expect(yield* stageOf(notClosed.id)).toEqual(Option.some('open'))
          expect(yield* allOpen()).toEqual([notClosed.id])
        }),
      ),
  )
})
