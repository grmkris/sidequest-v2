import { it } from '@effect/vitest'
import { publicKeyOf } from '@sidequest/nostr'
import { Effect } from 'effect'
import { describe, expect } from 'vitest'
import { defaultOverlapSeconds, type IndexConfig } from '../src/Index/IndexConfig.ts'
import { Poller } from '../src/Index/Poller.ts'
import { alice, carol, indexWorld, profile, relaying, request, testTiming } from './IndexWorld.ts'
import { withRelays } from './TestRelay.ts'

const now = () => Math.floor(Date.now() / 1000)
const hour = 3600

/** `count` requests by Alice, an hour apart, the newest `newestAgo` seconds ago. */
const requests = (count: number, newestAgo = 60, label = 'Job') =>
  Array.from({ length: count }, (_, index) => request(alice, now() - newestAgo - index * hour, `${label} ${index}`))

/** The poller over a fresh index that reads `urls`, and the database behind it. */
const pollerFor = (urls: ReadonlyArray<string>, overrides: Partial<IndexConfig> = {}) => {
  const { sqlite, layer } = indexWorld(relaying(urls, overrides))
  const run = Effect.flatMap(Poller, (poller) => poller.run).pipe(Effect.provide(layer))
  const count = (sql: string) => Number(sqlite.prepare(sql).get()?.['n'])
  const cursor = (url: string) => sqlite.prepare('SELECT * FROM relay_cursors WHERE relay = ?').get(url)
  return { sqlite, run, count, cursor }
}

const storedEvents = 'SELECT COUNT(*) AS n FROM events'

describe('the poller', () => {
  it.live('catches up on more than a page, from a relay that caps its pages below what it is asked', () =>
    withRelays([{ pageLimit: 3 }], ([relay]) =>
      Effect.gen(function* () {
        if (relay === undefined) return
        relay.seed(...requests(10))
        const { run, count, cursor } = pollerFor([relay.url])
        expect((yield* run).get(relay.url)).toBe('complete')
        expect(count(storedEvents)).toBe(10)
        expect(cursor(relay.url)?.['last_run_start']).toBeGreaterThan(0)
        // Down for longer than a page holds: eight more arrive, and the next run reads them all.
        relay.seed(...requests(8, 30, 'Later'))
        expect((yield* run).get(relay.url)).toBe('complete')
        expect(count(storedEvents)).toBe(18)
      }),
    ),
  )

  it.live('finds an event that reached the relay late but was signed within the overlap, and not one before it', () =>
    withRelays([{}], ([relay]) =>
      Effect.gen(function* () {
        if (relay === undefined) return
        const { run, count } = pollerFor([relay.url])
        yield* run
        const backdated = request(alice, now() - defaultOverlapSeconds + hour, 'Backdated')
        const tooOld = request(alice, now() - defaultOverlapSeconds - hour, 'Too old')
        relay.seed(backdated, tooOld)
        yield* run
        expect(count(`SELECT COUNT(*) AS n FROM events WHERE id = '${backdated.id}'`)).toBe(1)
        expect(count(`SELECT COUNT(*) AS n FROM events WHERE id = '${tooOld.id}'`)).toBe(0)
      }),
    ),
  )

  it.live('reads every other relay when one fails, and waits out the failed one’s backoff', () =>
    withRelays([{ unreachable: true }, {}], ([down, up]) =>
      Effect.gen(function* () {
        if (down === undefined || up === undefined) return
        up.seed(...requests(2))
        const { run, count, cursor } = pollerFor([down.url, up.url])
        const first = yield* run
        expect([first.get(down.url), first.get(up.url)]).toEqual(['failed', 'complete'])
        expect(count(storedEvents)).toBe(2)
        expect(cursor(down.url)).toMatchObject({ last_run_start: null, failures: 1 })
        expect(Number(cursor(down.url)?.['retry_after'])).toBeGreaterThan(now())
        expect((yield* run).get(down.url)).toBe('waiting')
      }),
    ),
  )

  it.live('moves the cursor only after a complete pass, and repeats a pass cut short without harm', () =>
    withRelays([{ pageLimit: 3, dropAfterRequests: 2 }], ([relay]) =>
      Effect.gen(function* () {
        if (relay === undefined) return
        relay.seed(...requests(10))
        const { sqlite, run, count, cursor } = pollerFor([relay.url])
        expect((yield* run).get(relay.url)).toBe('failed')
        expect(cursor(relay.url)?.['last_run_start']).toBeNull()
        const partial = count(storedEvents)
        expect(partial).toBeGreaterThan(0)
        expect(partial).toBeLessThan(10)
        // The relay recovers and its backoff ends: the next run reads the same span again, whole.
        relay.behaviour.dropAfterRequests = Number.POSITIVE_INFINITY
        sqlite.exec('UPDATE relay_cursors SET retry_after = 0')
        expect((yield* run).get(relay.url)).toBe('complete')
        expect(count(storedEvents)).toBe(10)
        expect(cursor(relay.url)).toMatchObject({ failures: 0 })
      }),
    ),
  )

  it.live('leaves the cursor where it was when a pass needs more pages than it may read', () =>
    withRelays([{ pageLimit: 3 }], ([relay]) =>
      Effect.gen(function* () {
        if (relay === undefined) return
        relay.seed(...requests(10))
        const { run, cursor } = pollerFor([relay.url], { timing: { ...testTiming, maxPages: 2 } })
        expect((yield* run).get(relay.url)).toBe('incomplete')
        expect(cursor(relay.url)).toBeUndefined()
      }),
    ),
  )

  it.live('reads the profiles of keys that signed Sidequest events, and nobody else’s', () =>
    withRelays([{}], ([relay]) =>
      Effect.gen(function* () {
        if (relay === undefined) return
        const { run, count } = pollerFor([relay.url])
        relay.seed(request(alice, now() - 60))
        yield* run
        relay.seed(profile(alice, now() - 30, { name: 'Alice' }), profile(carol, now() - 30, { name: 'Carol' }))
        yield* run
        expect(count(`SELECT COUNT(*) AS n FROM profiles WHERE pubkey = '${publicKeyOf(alice)}'`)).toBe(1)
        expect(count(`SELECT COUNT(*) AS n FROM profiles WHERE pubkey = '${publicKeyOf(carol)}'`)).toBe(0)
      }),
    ),
  )

  it.live('connects nowhere with no relays configured', () =>
    Effect.gen(function* () {
      const { run } = pollerFor([])
      expect((yield* run).size).toBe(0)
    }),
  )
})
