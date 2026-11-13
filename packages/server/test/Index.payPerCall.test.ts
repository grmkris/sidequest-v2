import { it } from '@effect/vitest'
import { EventId, publicKeyOf } from '@sidequest/nostr'
import { UsdcOnArcTestnet } from '@sidequest/protocol'
import { Effect, Option, Schema } from 'effect'
import { describe, expect } from 'vitest'
import { EventStore } from '../src/Index/EventStore.ts'
import { Ingest } from '../src/Index/Ingest.ts'
import { Listings } from '../src/Index/Listings.ts'
import { type DueCheck, PayPerCall, type TxOutcome } from '../src/Index/PayPerCall.ts'
import {
  accountOf,
  alice,
  arrivalKeys,
  arrivalOrder,
  bob,
  carol,
  grant,
  indexWorld,
  linked,
  revocation,
  walletOne,
  walletTwo,
} from './IndexWorld.ts'
import { listingBy } from './JobWorld.ts'
import { payPerCallListing, receiptBy } from './PayPerCallWorld.ts'

// The x402 rail in the index: a pay-per-call listing's payTo label, its receipts labelled verified only when the
// chain's recorded transfer, the listing version they name and the payer's wallet link all agree, and the same labels
// whatever order the events and the chain's facts arrived in. The chain's answers are recorded here as the chain log
// poller would record them (`PayPerCall.record`); the poller itself runs against Anvil in tools/x402.

const at = 1_800_000_000
const network = UsdcOnArcTestnet.network
const token = UsdcOnArcTestnet.id.toLowerCase()
const tx = (seed: string) => `0x${seed.repeat(32)}`
const buyerWallet = accountOf(walletOne)
const sellerWallet = accountOf(walletTwo)

const listing = payPerCallListing(bob, 'weather', at, sellerWallet)
const transfer = (from: string, to: string, value: string, logIndex = 0) => ({
  logIndex,
  asset: token,
  from,
  to,
  value,
})
const confirmed = (...transfers: ReadonlyArray<ReturnType<typeof transfer>>): TxOutcome => ({
  state: 'confirmed',
  block: 10,
  transfers,
})

const ingest = (event: unknown) => Effect.flatMap(Ingest, (index) => index.ingest(event, 'publish'))
const record = (txHash: string, outcome: TxOutcome) =>
  Effect.flatMap(PayPerCall, (store) => store.record({ network, txHash } satisfies DueCheck, outcome))

/** The receipts' labels and the listing's x402 block, after `steps` in order. */
const labelsAfter = (steps: ReadonlyArray<Effect.Effect<unknown, unknown, Ingest | PayPerCall>>) => {
  const { layer } = indexWorld()
  return Effect.gen(function* () {
    for (const step of steps) yield* step
    const receipts = yield* (yield* PayPerCall).receipts(publicKeyOf(bob), 'weather')
    const shown = yield* (yield* Listings).get(publicKeyOf(bob), 'weather')
    return {
      receipts: receipts.map(({ event, verified }) => [event, verified]).toSorted(),
      payPerCall: Option.getOrNull(Option.map(shown, ({ rail, payPerCall }) => ({ rail, payPerCall }))),
    }
  }).pipe(Effect.provide(layer))
}

describe('pay-per-call listings in the index', () => {
  it.effect('carry their resource and payTo, labelled linked only by the seller’s verified link', () =>
    Effect.gen(function* () {
      const unlinked = yield* labelsAfter([ingest(listing)])
      expect(unlinked.payPerCall).toEqual({
        rail: 'x402',
        payPerCall: {
          resource: 'https://weather.example.com/now',
          payTo: sellerWallet,
          payToLinked: false,
          verifiedReceipts: 0,
        },
      })
      const sellerLink = yield* Effect.promise(() => linked(bob, walletTwo, at))
      const linkedUp = yield* labelsAfter([ingest(listing), ingest(sellerLink)])
      expect(linkedUp.payPerCall?.payPerCall?.payToLinked).toBe(true)
      const someoneElse = yield* Effect.promise(() => linked(carol, walletTwo, at + 1))
      const relinked = yield* labelsAfter([ingest(listing), ingest(sellerLink), ingest(someoneElse)])
      expect(relinked.payPerCall?.payPerCall?.payToLinked).toBe(false)
    }),
  )

  it.effect('are found by rail; an escrow listing is the escrow rail with no x402 block', () => {
    const { layer } = indexWorld()
    return Effect.gen(function* () {
      yield* ingest(listing)
      yield* ingest(listingBy(alice, 'logos', at))
      const listings = yield* Listings
      const slugs = (rail?: 'escrow' | 'x402') =>
        Effect.map(listings.search({ rail }), ({ items }) => items.map(({ slug, rail: shown }) => [slug, shown]))
      expect(yield* slugs('x402')).toEqual([['weather', 'x402']])
      expect(yield* slugs('escrow')).toEqual([['logos', 'escrow']])
      expect(yield* slugs()).toHaveLength(2)
      const escrow = yield* listings.get(publicKeyOf(alice), 'logos')
      expect(Option.map(escrow, ({ payPerCall }) => payPerCall)).toEqual(Option.some(null))
    }).pipe(Effect.provide(layer))
  })
})

describe('a receipt is verified only when the chain agrees with it', () => {
  const pay = (txHash: string, amount = '10000', payer = buyerWallet) =>
    receiptBy(alice, { version: listing, payer, amount, transaction: txHash }, at + 60)

  it.effect('a transfer of the price from the author’s linked wallet to the listing’s payTo verifies', () =>
    Effect.gen(function* () {
      const buyerLink = yield* Effect.promise(() => linked(alice, walletOne, at))
      const good = pay(tx('a1'))
      const labels = yield* labelsAfter([
        ingest(listing),
        ingest(buyerLink),
        ingest(good),
        ingest(pay(tx('a1'))),
        record(tx('a1'), confirmed(transfer(buyerWallet, sellerWallet, '10000'))),
      ])
      expect(labels.receipts).toEqual([[good.id, true]])
      expect(labels.payPerCall?.payPerCall?.verifiedReceipts).toBe(1)
    }),
  )

  it.effect('a wrong payer, amount, payTo, pending or reverted transaction, or unlinked author does not', () =>
    Effect.gen(function* () {
      const buyerLink = yield* Effect.promise(() => linked(alice, walletOne, at))
      const stranger = accountOf(walletTwo)
      const cases = {
        // The chain moved the money from another wallet than the receipt's payer.
        wrongPayer: [pay(tx('b1')), confirmed(transfer(stranger, sellerWallet, '10000'))],
        // The receipt claims the price, the chain moved less.
        wrongAmount: [pay(tx('b2')), confirmed(transfer(buyerWallet, sellerWallet, '9999'))],
        // The receipt claims less than the price, and the chain agrees with it.
        underPrice: [pay(tx('b3'), '9999'), confirmed(transfer(buyerWallet, sellerWallet, '9999'))],
        // The money went to someone else than the listing's payTo.
        wrongPayTo: [pay(tx('b4')), confirmed(transfer(buyerWallet, accountOf(walletOne, 1), '10000'))],
        pending: [pay(tx('b5')), { state: 'pending' }],
        reverted: [pay(tx('b6')), { state: 'reverted', block: 9 }],
        // The receipt's payer is a wallet its author never linked.
        unlinked: [pay(tx('b7'), '10000', stranger), confirmed(transfer(stranger, sellerWallet, '10000'))],
      } as const
      const labels = yield* labelsAfter([
        ingest(listing),
        ingest(buyerLink),
        ...Object.values(cases).flatMap(([event, outcome]) => {
          const hash = Schema.decodeUnknownSync(Schema.String)(JSON.parse(event.content).transaction)
          return [ingest(event), record(hash, outcome)]
        }),
      ])
      expect(labels.receipts.every(([, verified]) => verified === false)).toBe(true)
      expect(labels.receipts).toHaveLength(Object.keys(cases).length)
      expect(labels.payPerCall?.payPerCall?.verifiedReceipts).toBe(0)
    }),
  )

  it.effect('an agent’s receipt counts under its operator’s grant with the accept scope, until revoked', () =>
    Effect.gen(function* () {
      const operatorLink = yield* Effect.promise(() => linked(alice, walletOne, at))
      const given = grant(alice, carol, { createdAt: at, notBefore: at, expiresAt: at + 3600 }, ['accept'])
      const discussOnly = grant(alice, carol, { createdAt: at, notBefore: at, expiresAt: at + 3600 }, ['discuss'])
      const claim = (txHash: string, grantId: string) =>
        receiptBy(
          carol,
          { version: listing, payer: buyerWallet, amount: '10000', transaction: txHash },
          at + 60,
          EventId.make(grantId),
        )
      const byAgent = claim(tx('c1'), given.id)
      const outOfScope = claim(tx('c2'), discussOnly.id)
      const steps = [
        ingest(listing),
        ingest(operatorLink),
        ingest(given),
        ingest(discussOnly),
        ingest(byAgent),
        ingest(outOfScope),
        record(tx('c1'), confirmed(transfer(buyerWallet, sellerWallet, '10000'))),
        record(tx('c2'), confirmed(transfer(buyerWallet, sellerWallet, '10000'))),
      ]
      expect((yield* labelsAfter(steps)).receipts).toEqual(
        [
          [byAgent.id, true],
          [outOfScope.id, false],
        ].toSorted(),
      )
      const revoked = yield* labelsAfter([...steps, ingest(revocation(alice, given.id, at + 7200))])
      expect(revoked.receipts.every(([, verified]) => verified === false)).toBe(true)
    }),
  )

  it.effect.prop(
    'are the same whatever order the events and the chain’s facts arrive in, and after a rebuild',
    [arrivalKeys(6)],
    ([keys]) =>
      Effect.gen(function* () {
        const buyerLink = yield* Effect.promise(() => linked(alice, walletOne, at))
        const sellerLink = yield* Effect.promise(() => linked(bob, walletTwo, at))
        const good = pay(tx('d1'))
        const bad = pay(tx('d2'))
        const steps = [
          ingest(listing),
          ingest(buyerLink),
          ingest(sellerLink),
          ingest(good),
          ingest(bad),
          Effect.andThen(
            record(tx('d1'), confirmed(transfer(buyerWallet, sellerWallet, '10000'))),
            record(tx('d2'), confirmed(transfer(buyerWallet, sellerWallet, '1'))),
          ),
        ]
        const expected = {
          receipts: [
            [good.id, true],
            [bad.id, false],
          ].toSorted(),
          payPerCall: {
            rail: 'x402',
            payPerCall: {
              resource: 'https://weather.example.com/now',
              payTo: sellerWallet,
              payToLinked: true,
              verifiedReceipts: 1,
            },
          },
        }
        expect(yield* labelsAfter(arrivalOrder(steps, keys, 2))).toEqual(expected)
        const rebuilt = yield* labelsAfter([...steps, Effect.flatMap(EventStore, (store) => store.rebuild)])
        expect(rebuilt).toEqual(expected)
      }),
    { timeout: 60_000, arbitrary: { runs: 10 } },
  )
})
