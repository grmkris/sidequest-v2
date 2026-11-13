import { IndexListingDetail, UsdcOnArcTestnet } from '@sidequest/protocol'
import { Option, Schema } from 'effect'
import { expect, given, role, scene, text } from 'foldkit/scene'
import { describe, test } from 'vitest'
import { Me } from '../../src/Me.ts'
import { init, update, view } from '../../src/page/ListingPage.ts'
import { Preload } from '../../src/Preload.ts'
import { bidderKey, now } from '../Fixtures.ts'

// A pay-per-call listing's page (ADR-0006): the price of one call, where it is paid and whether that is the seller's
// linked wallet, how many payments the chain verified, that there is no refund, and how to pay and call it from an
// agent or an x402 client. The page calls nothing and builds no payment.

const resource = 'https://weather.example.com/now'
const payTo = `${UsdcOnArcTestnet.network}:0x${'5e'.repeat(20)}`

const listingWith = (payToLinked: boolean) =>
  Schema.decodeSync(IndexListingDetail)({
    pubkey: bidderKey,
    slug: 'weather',
    event: 'f5'.repeat(32),
    createdAt: now,
    title: 'Weather now',
    summary: 'The weather, as JSON.',
    description: 'One call, one forecast.',
    topics: ['weather'],
    price: { amount: '10000', asset: UsdcOnArcTestnet.id },
    network: UsdcOnArcTestnet.network,
    status: 'active',
    publishedAt: now,
    author: { name: 'Ben', walletVerified: true },
    rail: 'x402',
    payPerCall: { resource, payTo, payToLinked, verifiedReceipts: 3 },
  })

const opened = (payToLinked: boolean) =>
  init(
    'en',
    { pubkey: bidderKey, slug: 'weather' },
    Me.NoSigner(),
    Option.some(Preload.Listing({ listing: listingWith(payToLinked) })),
  ).model

describe('a pay-per-call listing’s page', () => {
  test('shows the price per call, the seller’s linked payTo, the verified payments, no refunds, and how to call it', () => {
    scene(
      { update, view },
      given(opened(true)),
      expect(role('region', { name: 'Pay per call' })).toExist(),
      expect(text('0.01 USDC per call')).toExist(),
      expect(text(resource)).toExist(),
      expect(text(payTo)).toExist(),
      expect(text("The seller's linked wallet")).toExist(),
      expect(text('3')).toExist(),
      expect(text(/no escrow, no review, no dispute and no refund/u)).toExist(),
      expect(role('region', { name: 'Pay and call' })).toExist(),
      expect(text(`curl -i '${resource}'`)).toExist(),
      expect(role('alert')).not.toExist(),
    )
  })

  test('warns not to pay when the payTo is not the seller’s linked wallet', () => {
    scene(
      { update, view },
      given(opened(false)),
      expect(role('alert')).toHaveText(/Do not pay it/u),
      expect(text("Not the seller's linked wallet")).toExist(),
    )
  })
})
