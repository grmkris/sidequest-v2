import { it } from '@effect/vitest'
import { publicKeyOf, type SecretKey } from '@sidequest/nostr'
import { Effect, Option, Schema } from 'effect'
import { describe, expect } from 'vitest'
import { grantStatus } from '../src/Index/Derived.ts'
import { EventStore, type KnownGrant } from '../src/Index/EventStore.ts'
import { Ingest } from '../src/Index/Ingest.ts'
import {
  accountOf,
  alice,
  bob,
  carol,
  derivedTables,
  grant,
  indexWorld,
  linked,
  revocation,
  service,
  walletLinkEvent,
  walletOne,
  walletSignature,
  walletTwo,
} from './IndexWorld.ts'

// Identity in the index: which key each wallet is linked to, and which agents act for whom. Both are folds over the
// events alone, so every arrival order and a rebuild must give the same answers.

const at = 1_800_000_000
const otherChain = 1

const contractAccount = `eip155:5042002:0x${'5a1e'.repeat(10)}`

// Alice links wallet one, then wallet one re-links to Bob: the recovery path, so Alice loses it. Carol and the service
// link wallet two in the same second, so the lower event id wins. Alice claims wallet two with a signature it made for
// Carol (a forgery, as far as the index can tell) and a contract wallet with a signature only its chain could check:
// both are kept, labelled unverified, and displace no one. Alice also holds both wallets on another chain.
const aliceOnOne = await linked(alice, walletOne, at)
const bobOnOne = await linked(bob, walletOne, at + 10)
const carolOnTwo = await linked(carol, walletTwo, at + 5)
const serviceOnTwo = await linked(service, walletTwo, at + 5)
const forged = walletLinkEvent(alice, accountOf(walletTwo), at + 100, await walletSignature(walletTwo, carol, at + 100))
const contract = walletLinkEvent(alice, contractAccount, at + 100, `0x${'ab'.repeat(100)}`)
const aliceTwoElsewhere = await linked(alice, walletTwo, at, otherChain)
const aliceOneElsewhere = await linked(alice, walletOne, at + 1, otherChain)

const links = [aliceOnOne, bobOnOne, carolOnTwo, serviceOnTwo, forged, contract, aliceTwoElsewhere, aliceOneElsewhere]
const tied = [carolOnTwo, serviceOnTwo].toSorted((a, b) => (a.id < b.id ? -1 : 1))

// Alice grants Carol, revokes it (the revocation listed first, so it arrives first in the pool's own order) and grants
// her again. Bob grants Carol, and the service, a stranger to that grant, revokes it: that counts for nothing. Bob grants
// the service from a time still to come; Alice granted the service once, long expired.
const window = { createdAt: at, notBefore: at, expiresAt: at + 1000 }
const aliceToCarol = grant(alice, carol, window)
const aliceRevokes = revocation(alice, aliceToCarol.id, at + 50)
const aliceToCarolAgain = grant(alice, carol, { ...window, createdAt: at + 60, expiresAt: at + 2000 }, ['accept'])
const bobToCarol = grant(bob, carol, window)
const strangerRevokes = revocation(service, bobToCarol.id, at + 70)
const bobToService = grant(bob, service, { createdAt: at, notBefore: at + 500, expiresAt: at + 600 })
const aliceToService = grant(alice, service, { createdAt: at - 2000, notBefore: at - 1000, expiresAt: at - 10 })

const grants = [
  aliceRevokes,
  aliceToCarol,
  aliceToCarolAgain,
  bobToCarol,
  strangerRevokes,
  bobToService,
  aliceToService,
]

const keys: ReadonlyArray<SecretKey> = [alice, bob, carol, service]
const accounts = [accountOf(walletOne), accountOf(walletTwo), accountOf(walletOne, otherChain), contractAccount]

const ingestAll = (events: ReadonlyArray<unknown>) =>
  Effect.flatMap(Ingest, (index) => Effect.forEach(events, (event) => index.ingest(event, 'publish')))

/** What the reads answer for every key and account the pools name: the identity half of what the index knows. */
const identityReads = Effect.gen(function* () {
  const store = yield* EventStore
  const people = yield* Effect.forEach(keys, (key) =>
    Effect.map(store.known(publicKeyOf(key)), ({ wallets, unverifiedWallets, agents, operators }) => ({
      wallets,
      unverifiedWallets,
      agents,
      operators,
    })),
  )
  const owners = yield* Effect.forEach(accounts, (account) => store.wallet(account))
  return { people, owners }
})

/** The derived tables and the reads after ingesting `events` in this order into a fresh index. */
const afterArriving = (events: ReadonlyArray<unknown>) => {
  const { sqlite, layer } = indexWorld()
  return ingestAll(events).pipe(
    Effect.flatMap(() => identityReads),
    Effect.map((reads) => ({ tables: derivedTables(sqlite), reads })),
    Effect.provide(layer),
  )
}

const inPoolOrder = (pool: ReadonlyArray<unknown>) => {
  let computed: Promise<Effect.Success<ReturnType<typeof afterArriving>>> | undefined
  return Effect.promise(() => {
    computed ??= Effect.runPromise(afterArriving(pool))
    return computed
  })
}
const linksInOrder = inPoolOrder(links)
const grantsInOrder = inPoolOrder(grants)

/** The pool shuffled by `keys`, with its first three events arriving a second time. */
const shuffled = (pool: ReadonlyArray<unknown>, sortKeys: ReadonlyArray<number>) => {
  const order = pool.map((event, index) => ({ event, key: sortKeys[index] ?? 0 })).toSorted((a, b) => a.key - b.key)
  return [...order.map(({ event }) => event), ...order.slice(0, 3).map(({ event }) => event)]
}

const sortKeysFor = (pool: ReadonlyArray<unknown>) =>
  Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 }))).check(
    Schema.isBetweenLength(pool.length, pool.length),
  )

const ownerOf = (reads: Effect.Success<typeof identityReads>, account: string) =>
  Option.getOrUndefined(reads.owners[accounts.indexOf(account)] ?? Option.none())

const personOf = (reads: Effect.Success<typeof identityReads>, key: SecretKey) => reads.people[keys.indexOf(key)]

const statusesAt = (now: number, list: ReadonlyArray<KnownGrant> = []) =>
  list.map((known) => ({ event: known.eventId, status: grantStatus(known, now) }))

describe('which key a wallet is linked to', () => {
  it.effect('is the verified link with the greatest issuedAt, ties to the lowest event id', () =>
    Effect.map(linksInOrder, ({ reads }) => {
      expect(ownerOf(reads, accountOf(walletOne))).toMatchObject({ pubkey: publicKeyOf(bob), eventId: bobOnOne.id })
      expect(ownerOf(reads, accountOf(walletTwo))).toMatchObject({ eventId: tied[0]?.id, verification: 'verified' })
    }),
  )

  it.effect('never comes from a link the index could not verify, and such a link displaces no one', () =>
    Effect.map(linksInOrder, ({ reads }) => {
      expect(ownerOf(reads, contractAccount)).toBeUndefined()
      expect(
        personOf(reads, alice)
          ?.unverifiedWallets.map(({ eventId }) => eventId)
          .toSorted(),
      ).toEqual([forged.id, contract.id].toSorted())
      expect(personOf(reads, alice)?.unverifiedWallets.every(({ verification }) => verification === 'unverified')).toBe(
        true,
      )
    }),
  )

  it.effect('leaves a key holding every wallet it still wins, one per account, and none it lost', () =>
    Effect.map(linksInOrder, ({ reads }) => {
      expect(personOf(reads, alice)?.wallets.map(({ account }) => account)).toEqual([
        accountOf(walletOne, otherChain),
        accountOf(walletTwo, otherChain),
      ])
      expect(personOf(reads, bob)?.wallets.map(({ account }) => account)).toEqual([accountOf(walletOne)])
      const tieLoser = tied[1] === carolOnTwo ? carol : service
      expect(personOf(reads, tieLoser)?.wallets).toEqual([])
    }),
  )

  it.effect.prop(
    'is the same for any arrival order of the same links, duplicates included',
    [sortKeysFor(links)],
    ([sortKeys]) =>
      Effect.gen(function* () {
        expect(yield* afterArriving(shuffled(links, sortKeys))).toEqual(yield* linksInOrder)
      }),
    { timeout: 60_000, arbitrary: { runs: 15 } },
  )
})

describe('an agent grant', () => {
  const now = at + 100

  it.effect('is revoked only by its own operator, even when the revocation arrived first', () =>
    Effect.map(grantsInOrder, ({ reads }) => {
      expect(statusesAt(now, personOf(reads, alice)?.agents)).toEqual([
        { event: aliceToCarolAgain.id, status: 'active' },
        { event: aliceToCarol.id, status: 'revoked' },
        { event: aliceToService.id, status: 'expired' },
      ])
      expect(statusesAt(now, personOf(reads, bob)?.agents).toSorted((a, b) => (a.event < b.event ? -1 : 1))).toEqual(
        [
          { event: bobToCarol.id, status: 'active' },
          { event: bobToService.id, status: 'notYet' },
        ].toSorted((a, b) => (a.event < b.event ? -1 : 1)),
      )
    }),
  )

  it.effect('reaches its agent as an operator while unrevoked, with what it allows', () =>
    Effect.map(grantsInOrder, ({ reads }) => {
      const operators = personOf(reads, carol)?.operators ?? []
      expect(operators.map(({ eventId }) => eventId).toSorted()).toEqual(
        [aliceToCarolAgain.id, bobToCarol.id].toSorted(),
      )
      expect(operators.find(({ eventId }) => eventId === aliceToCarolAgain.id)).toMatchObject({
        operator: publicKeyOf(alice),
        agent: publicKeyOf(carol),
        scopes: ['accept'],
        notBefore: at,
        expiresAt: at + 2000,
      })
      expect(
        statusesAt(now, personOf(reads, service)?.operators)
          .map(({ status }) => status)
          .toSorted(),
      ).toEqual(['expired', 'notYet'])
    }),
  )

  it.effect('takes its status from the time of the read: not yet, active, then expired', () =>
    Effect.sync(() => {
      const known = { notBefore: at, expiresAt: at + 10, revoked: false }
      expect([at - 1, at, at + 9, at + 10].map((moment) => grantStatus(known, moment))).toEqual([
        'notYet',
        'active',
        'active',
        'expired',
      ])
      expect(grantStatus({ ...known, revoked: true }, at)).toBe('revoked')
    }),
  )

  it.effect.prop(
    'reads the same for any arrival order of the same grants and revocations, duplicates included',
    [sortKeysFor(grants)],
    ([sortKeys]) =>
      Effect.gen(function* () {
        expect(yield* afterArriving(shuffled(grants, sortKeys))).toEqual(yield* grantsInOrder)
      }),
    { timeout: 60_000, arbitrary: { runs: 15 } },
  )
})

describe('identity rebuilt from the events table alone', () => {
  it.effect('equals what ingestion built', () => {
    const { sqlite, layer } = indexWorld()
    return Effect.gen(function* () {
      yield* ingestAll([...links, ...grants].toReversed())
      const incremental = { tables: derivedTables(sqlite), reads: yield* identityReads }
      sqlite.exec('DELETE FROM wallet_links')
      sqlite.exec("UPDATE agent_grants SET operator = 'tampered'")
      sqlite.exec('DELETE FROM grant_revocations')
      yield* Effect.flatMap(EventStore, (store) => store.rebuild)
      expect({ tables: derivedTables(sqlite), reads: yield* identityReads }).toEqual(incremental)
      expect(incremental.tables.walletLinks).toHaveLength(links.length)
      expect(incremental.tables.revocations).toHaveLength(2)
    }).pipe(Effect.provide(layer))
  })
})
