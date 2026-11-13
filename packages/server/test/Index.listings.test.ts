import { it } from '@effect/vitest'
import { publicKeyOf } from '@sidequest/nostr'
import { Effect, Option } from 'effect'
import { describe, expect } from 'vitest'
import { EventStore } from '../src/Index/EventStore.ts'
import { Ingest } from '../src/Index/Ingest.ts'
import { Listings } from '../src/Index/Listings.ts'
import { alice, arrivalKeys, arrivalOrder, bob, carol, indexWorld, linked, profile, walletOne } from './IndexWorld.ts'
import { listingBy } from './JobWorld.ts'

const at = 1_800_000_000

const ingest = (event: unknown) => Effect.flatMap(Ingest, (index) => index.ingest(event, 'publish'))

const listingsTable = (sqlite: ReturnType<typeof indexWorld>['sqlite']) =>
  sqlite.prepare('SELECT * FROM nostr_listings ORDER BY pubkey, d').all()

// Versions of three sellers' listings: replacements, three versions of one slug signed in the same second (the lowest
// id must win), an older version arriving last, and two slugs of one seller.
const pool = [
  listingBy(alice, 'logos', at, { title: 'Logos one' }),
  listingBy(alice, 'logos', at, { title: 'Logos two' }),
  listingBy(alice, 'logos', at, { title: 'Logos three' }),
  listingBy(alice, 'logos', at - 50, { title: 'Logos old' }),
  listingBy(alice, 'icons', at + 10, { title: 'Icons', topics: ['design', 'icons'] }),
  listingBy(bob, 'guides', at + 5, { title: 'Guides new', topics: ['translation'] }),
  listingBy(bob, 'guides', at, { title: 'Guides old' }),
  listingBy(carol, 'audits', at + 20, { title: 'Audits', summary: 'Solidity 100% reviewed_' }, false),
]

const tableAfter = (events: ReadonlyArray<unknown>) => {
  const { sqlite, layer } = indexWorld()
  return Effect.forEach(events, ingest).pipe(
    Effect.provide(layer),
    Effect.map(() => listingsTable(sqlite)),
  )
}

let ownOrder: Promise<ReturnType<typeof listingsTable>> | undefined
const expected = Effect.promise(() => {
  ownOrder ??= Effect.runPromise(tableAfter(pool))
  return ownOrder
})

describe('the listings the index derives', () => {
  it.effect('keep each seller’s latest per slug: greatest created_at, then the lowest id', () =>
    Effect.map(expected, (rows) => {
      const sameSecond = pool
        .slice(0, 3)
        .map(({ id }) => id)
        .toSorted()[0]
      expect(rows.map((row) => [row['d'], row['event_id'] === sameSecond || row['title']])).toEqual(
        expect.arrayContaining([
          ['logos', true],
          ['guides', 'Guides new'],
        ]),
      )
      expect(rows).toHaveLength(4)
    }),
  )

  it.effect.prop(
    'are the same for any arrival order of the same events, duplicates included',
    [arrivalKeys(pool.length)],
    ([keys]) =>
      Effect.gen(function* () {
        expect(yield* tableAfter(arrivalOrder(pool, keys, 2))).toEqual(yield* expected)
      }),
    { timeout: 60_000, arbitrary: { runs: 15 } },
  )

  it.effect('rebuilt from the events table alone equal what ingestion built', () => {
    const { sqlite, layer } = indexWorld()
    return Effect.gen(function* () {
      yield* Effect.forEach(pool.toReversed(), ingest)
      const incremental = listingsTable(sqlite)
      sqlite.exec("UPDATE nostr_listings SET title = 'tampered'")
      sqlite.exec("DELETE FROM nostr_listings WHERE d = 'guides'")
      yield* Effect.flatMap(EventStore, (store) => store.rebuild)
      expect(listingsTable(sqlite)).toEqual(incremental)
      expect(incremental).toEqual(yield* expected)
    }).pipe(Effect.provide(layer))
  })
})

const titles = (page: { readonly items: ReadonlyArray<{ readonly title: string }> }) =>
  page.items.map(({ title }) => title)

describe('searching listings', () => {
  const searched = Effect.gen(function* () {
    yield* Effect.forEach(pool, ingest)
    return yield* Listings
  })

  it.effect('pages newest first by keyset, and finds text in titles and summaries and topics exactly', () =>
    Effect.gen(function* () {
      const listings = yield* searched
      const first = yield* listings.search({ limit: 2 })
      expect(titles(first)).toEqual(['Audits', 'Icons'])
      const second = yield* listings.search({ limit: 2, cursor: first.next ?? undefined })
      expect(titles(second)).toHaveLength(2)
      expect(second.next).toBeNull()
      expect(titles(yield* listings.search({ q: 'GUIDES' }))).toEqual(['Guides new'])
      expect(titles(yield* listings.search({ q: 'slovenian' }))).toHaveLength(3)
      // `%` and `_` are characters to find, not wildcards.
      expect(titles(yield* listings.search({ q: '100%' }))).toEqual(['Audits'])
      expect(titles(yield* listings.search({ q: '0_' }))).toEqual([])
      expect(titles(yield* listings.search({ tag: 'icons' }))).toEqual(['Icons'])
      expect(titles(yield* listings.search({ tag: 'icon' }))).toEqual([])
      expect(titles(yield* listings.search({ q: 'logos', tag: 'design' }))).toEqual([])
    }).pipe(Effect.provide(indexWorld().layer)),
  )

  it.effect('labels each listing with its author’s name and whether a verified link holds a wallet for them', () =>
    Effect.gen(function* () {
      const listings = yield* searched
      yield* ingest(profile(bob, at, { name: 'Bob' }))
      yield* ingest(yield* Effect.promise(() => linked(bob, walletOne, at)))
      const guides = yield* listings.get(publicKeyOf(bob), 'guides')
      expect(Option.getOrThrow(guides)).toMatchObject({
        title: 'Guides new',
        description: 'I translate guides.',
        price: { amount: '50000000' },
        network: 'eip155:5042002',
        author: { name: 'Bob', walletVerified: true },
      })
      const audits = Option.getOrThrow(yield* listings.get(publicKeyOf(carol), 'audits'))
      expect(audits).toMatchObject({ price: null, network: null, author: { name: null, walletVerified: false } })
      // Alice relinks Bob's wallet to herself: Bob no longer holds a wallet.
      yield* ingest(yield* Effect.promise(() => linked(alice, walletOne, at + 1)))
      expect(Option.getOrThrow(yield* listings.get(publicKeyOf(bob), 'guides')).author.walletVerified).toBe(false)
      expect(yield* listings.get(publicKeyOf(bob), 'missing')).toEqual(Option.none())
    }).pipe(Effect.provide(indexWorld().layer)),
  )
})
