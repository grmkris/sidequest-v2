import { it } from '@effect/vitest'
import { publicKeyOf } from '@sidequest/nostr'
import { standardKinds } from '@sidequest/nostr/vocabulary'
import { Effect, Schema } from 'effect'
import { describe, expect } from 'vitest'
import { EventStore } from '../src/Index/EventStore.ts'
import { Ingest } from '../src/Index/Ingest.ts'
import { eventLimits } from '../src/Index/Validation.ts'
import {
  alice,
  bob,
  carol,
  derivedTables,
  indexWorld,
  messagingRelays,
  profile,
  relayList,
  request,
  signed,
} from './IndexWorld.ts'

const at = 1_800_000_000

/** What ingesting `input` answers: stored, duplicate, or the reason it was refused. */
const outcomeOf = (input: unknown) =>
  Effect.flatMap(Ingest, (index) => index.ingest(input, 'publish')).pipe(
    Effect.map(({ status }) => status),
    Effect.catchTag('EventRefused', (refused) => Effect.succeed(refused.reason)),
  )

const inIndex = <A, E>(effect: Effect.Effect<A, E, Ingest | EventStore>) => Effect.provide(effect, indexWorld().layer)

describe('ingesting an event', () => {
  it.effect('stores a valid event once, and finds it a duplicate after', () =>
    inIndex(
      Effect.gen(function* () {
        const event = request(alice, at)
        expect(yield* outcomeOf(event)).toBe('stored')
        expect(yield* outcomeOf(event)).toBe('duplicate')
        const found = yield* Effect.flatMap(EventStore, (store) => store.find(event.id))
        expect(found).toMatchObject({ _tag: 'Some', value: event })
      }),
    ),
  )

  it.effect('refuses for every reason: shape, id, signature, size, kind and vocabulary', () =>
    inIndex(
      Effect.gen(function* () {
        const event = request(alice, at)
        expect(yield* outcomeOf({ ...event, sig: 'zz' })).toBe('malformed')
        expect(yield* outcomeOf({ ...event, content: `${event.content} ` })).toBe('idMismatch')
        expect(yield* outcomeOf({ ...event, sig: request(bob, at).sig })).toBe('badSignature')
        const huge = signed({ created_at: at, kind: 0, tags: [], content: 'x'.repeat(eventLimits.contentLength + 1) })
        expect(yield* outcomeOf(huge)).toBe('tooLarge')
        const tagged = signed({
          created_at: at,
          kind: 0,
          tags: Array.from({ length: eventLimits.tags + 1 }, () => ['t', 'x']),
          content: '{}',
        })
        expect(yield* outcomeOf(tagged)).toBe('tooLarge')
        expect(yield* outcomeOf(signed({ created_at: at, kind: 1, tags: [], content: 'hi' }))).toBe('unknownKind')
        expect(yield* outcomeOf(signed({ created_at: at, kind: 0, tags: [], content: 'not json' }))).toBe('badContent')
        expect(yield* outcomeOf(signed({ ...event, tags: [...event.tags, ['p', publicKeyOf(bob)]] }))).toBe(
          'tagMismatch',
        )
        // A NIP-99 listing that is not Sidequest's: no vocabulary version.
        const foreign = signed({ created_at: at, kind: standardKinds.listing, tags: [['d', 'x']], content: 'Hi' })
        expect(yield* outcomeOf(foreign)).toBe('badEnvelope')
      }),
    ),
  )

  it.effect('records which validation an event passed, and indexes its tags', () => {
    const { sqlite, layer } = indexWorld()
    return Effect.gen(function* () {
      yield* outcomeOf(request(alice, at))
      yield* outcomeOf(profile(bob, at, { name: 'Bob' }))
      yield* outcomeOf(relayList(carol, at, { read: ['wss://a.example.com'], write: [] }))
      const validations = sqlite.prepare('SELECT validation FROM events ORDER BY validation').all()
      expect(validations.map((row) => row['validation'])).toEqual(['profile', 'relayList', 'sidequest'])
      const tags = sqlite.prepare("SELECT name, value FROM event_tags WHERE name IN ('sq', 'r') ORDER BY name").all()
      expect(tags).toEqual([
        { name: 'r', value: 'wss://a.example.com' },
        { name: 'sq', value: '2' },
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect('derives a profile and relay lists, keeping only well-formed fields', () => {
    const { layer } = indexWorld()
    return Effect.gen(function* () {
      yield* outcomeOf(profile(bob, at, { name: 'Bob', about: 'Draws', picture: 'javascript:alert(1)' }))
      yield* outcomeOf(relayList(bob, at, { read: ['wss://r.example.com'], write: ['wss://w.example.com'] }))
      yield* outcomeOf(messagingRelays(bob, at, ['wss://dm.example.com']))
      const known = yield* Effect.flatMap(EventStore, (store) => store.known(publicKeyOf(bob)))
      expect(known.profile).toMatchObject({ value: { name: 'Bob', about: 'Draws', picture: null } })
      expect(known.relayList).toMatchObject({
        value: { read: ['wss://r.example.com'], write: ['wss://w.example.com'] },
      })
      expect(known.messagingRelays).toMatchObject({ value: { read: ['wss://dm.example.com'], write: [] } })
    }).pipe(Effect.provide(layer))
  })
})

// Several replaceable events per key, three of them in the same second, so the tie-break decides.
const pool = [
  profile(alice, at, { name: 'Alice one' }),
  profile(alice, at, { name: 'Alice two' }),
  profile(alice, at, { name: 'Alice three' }),
  profile(alice, at - 10, { name: 'Alice old' }),
  profile(bob, at + 5, { name: 'Bob new' }),
  profile(bob, at, { name: 'Bob' }),
  relayList(alice, at, { read: ['wss://a.example.com'], write: [] }),
  relayList(alice, at, { read: [], write: ['wss://b.example.com'] }),
  relayList(alice, at - 1, { read: ['wss://c.example.com'], write: [] }),
  relayList(bob, at, { read: ['wss://d.example.com'], write: ['wss://d.example.com'] }),
  messagingRelays(alice, at, ['wss://e.example.com']),
  messagingRelays(alice, at, ['wss://f.example.com']),
  messagingRelays(carol, at + 1, ['wss://g.example.com']),
]

/** The derived tables after ingesting `events` in this order into a fresh index. */
const derivedAfter = (events: ReadonlyArray<unknown>) => {
  const { sqlite, layer } = indexWorld()
  return Effect.forEach(events, outcomeOf).pipe(
    Effect.provide(layer),
    Effect.map(() => derivedTables(sqlite)),
  )
}

// The tables after ingesting the pool in its own order, computed once: verifying each event takes milliseconds.
let ownOrder: Promise<ReturnType<typeof derivedTables>> | undefined
const expected = Effect.promise(() => {
  ownOrder ??= Effect.runPromise(derivedAfter(pool))
  return ownOrder
})

const lowest = (events: ReadonlyArray<{ readonly id: string }>) => events.map(({ id }) => id).toSorted()[0]

describe('what an index derives', () => {
  it.effect('is NIP-01’s latest: greatest created_at, then lowest id', () =>
    Effect.map(expected, (tables) => {
      const aliceProfiles = pool.slice(0, 3)
      expect(tables.profiles.find((row) => row['pubkey'] === publicKeyOf(alice))?.['event_id']).toBe(
        lowest(aliceProfiles),
      )
      expect(tables.profiles.find((row) => row['pubkey'] === publicKeyOf(bob))?.['name']).toBe('Bob new')
    }),
  )

  it.effect.prop(
    'is the same for any arrival order of the same events, duplicates included',
    [
      Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 }))).check(
        Schema.isBetweenLength(pool.length, pool.length),
      ),
    ],
    ([keys]) => {
      const order = pool.map((event, index) => ({ event, key: keys[index] ?? 0 })).toSorted((a, b) => a.key - b.key)
      const arrived = [...order.map(({ event }) => event), ...order.slice(0, 3).map(({ event }) => event)]
      return Effect.gen(function* () {
        expect(yield* derivedAfter(arrived)).toEqual(yield* expected)
      })
    },
    { timeout: 60_000, arbitrary: { runs: 15 } },
  )

  it.effect('rebuilt from the events table alone equals what ingestion built', () => {
    const { sqlite, layer } = indexWorld()
    return Effect.gen(function* () {
      yield* Effect.forEach(pool.toReversed(), outcomeOf)
      const incremental = derivedTables(sqlite)
      sqlite.exec("UPDATE profiles SET name = 'tampered'")
      sqlite.exec('DELETE FROM relay_lists')
      yield* Effect.flatMap(EventStore, (store) => store.rebuild)
      expect(derivedTables(sqlite)).toEqual(incremental)
      expect(incremental).toEqual(yield* expected)
    }).pipe(Effect.provide(layer))
  })
})
