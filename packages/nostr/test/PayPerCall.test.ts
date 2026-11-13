import { it } from '@effect/vitest'
import { UsdcOnArcTestnet } from '@sidequest/protocol'
import { Effect, Schema } from 'effect'
import { describe, expect } from 'vitest'
import type { EventTemplate } from '../src/Event.ts'
import { publicKeyOf } from '../src/Keys.ts'
import { listingAddressOf, ListingSlug } from '../src/ListingAddress.ts'
import { paymentReceipt, PaymentReceiptContent } from '../src/PaymentReceipt.ts'
import { parseServiceListing, ServiceListing, serviceListingTemplate } from '../src/ServiceListing.ts'
import { buildSidequestEvent, parseSidequestEvent } from '../src/SidequestEvent.ts'
import { finalizeEvent } from '../src/Sign.ts'
import { alice, bob, zeros } from './fixtures.ts'

// The x402 rail's vocabulary (ADR-0006): a NIP-99 listing that names a pay-per-call resource and the wallet it pays,
// and a buyer's receipt for one paid call. Both readers are strict: a tag the content does not imply is refused.

const wallet = `${UsdcOnArcTestnet.network}:0x${'ab'.repeat(20)}`
const priced = {
  slug: 'weather-now',
  title: 'Weather now',
  summary: 'The weather at a place, as JSON',
  description: 'One call, one forecast.',
  topics: ['weather'],
  price: { amount: '10000', asset: UsdcOnArcTestnet.id },
  status: 'active',
  publishedAt: 1_800_000_000,
} as const
const payPerCall = Schema.decodeSync(ServiceListing)({
  ...priced,
  x402: { resource: 'https://weather.example.com/now', payTo: wallet },
})

const sign = (template: EventTemplate, key = bob) => finalizeEvent(template, key, zeros)
const outcome = <A>(effect: Effect.Effect<A, { readonly reason: string }>) =>
  effect.pipe(
    Effect.map(() => 'accepted'),
    Effect.catch((error) => Effect.succeed(error.reason)),
  )
const escrowListing = Schema.decodeSync(ServiceListing)(priced)
const decodes = (input: unknown) => Schema.decodeUnknownExit(ServiceListing)(input)._tag === 'Success'

describe('a pay-per-call listing', () => {
  it.effect('carries its resource and payTo as tags beside its exact price, and reads back the same', () =>
    Effect.gen(function* () {
      const event = sign(serviceListingTemplate(payPerCall, 1_800_000_100))
      expect(event.tags).toEqual(
        expect.arrayContaining([
          ['sq-x402', 'https://weather.example.com/now'],
          ['sq-pay-to', wallet],
          ['sq-price', '10000', UsdcOnArcTestnet.id],
        ]),
      )
      expect((yield* parseServiceListing(event)).listing).toEqual(payPerCall)
    }),
  )

  it.effect('refuses a resource tag on an escrow listing, a missing payTo and a repeated resource', () =>
    Effect.gen(function* () {
      const escrow = sign(serviceListingTemplate(escrowListing, 1_800_000_100))
      const event = sign(serviceListingTemplate(payPerCall, 1_800_000_100))
      const retag = (tags: EventTemplate['tags']) => sign({ ...event, tags })
      expect(
        yield* outcome(
          parseServiceListing(sign({ ...escrow, tags: [...escrow.tags, ['sq-x402', 'https://a.example']] })),
        ),
      ).toBe('badContent')
      expect(yield* outcome(parseServiceListing(retag(event.tags.filter((tag) => tag[0] !== 'sq-pay-to'))))).toBe(
        'badContent',
      )
      expect(yield* outcome(parseServiceListing(retag([...event.tags, ['sq-x402', 'https://b.example/now']])))).toBe(
        'tagMismatch',
      )
    }),
  )

  it('needs a price, on the network of its payTo, and an https resource without credentials', () => {
    const { price: _price, ...unpriced } = priced
    expect(decodes({ ...unpriced, x402: payPerCall.x402 })).toBe(false)
    expect(decodes({ ...priced, x402: { ...payPerCall.x402, payTo: `eip155:8453:0x${'ab'.repeat(20)}` } })).toBe(false)
    for (const resource of ['http://weather.example.com/now', 'https://user:pw@weather.example.com/', 'https://a b'])
      expect(decodes({ ...priced, x402: { ...payPerCall.x402, resource } })).toBe(false)
    expect(decodes({ ...priced, x402: { ...payPerCall.x402, payTo: wallet.toUpperCase() } })).toBe(false)
  })
})

describe('a payment receipt', () => {
  const event = sign(serviceListingTemplate(payPerCall, 1_800_000_100))
  const listing = listingAddressOf(publicKeyOf(bob), ListingSlug.make('weather-now'))
  const receipt = Schema.decodeSync(PaymentReceiptContent)({
    listing,
    version: event.id,
    resource: 'https://weather.example.com/now',
    payer: `${UsdcOnArcTestnet.network}:0x${'cd'.repeat(20)}`,
    amount: '10000',
    asset: UsdcOnArcTestnet.id,
    transaction: `0x${'12'.repeat(32)}`,
  })

  it.effect('names the listing, its version and its seller, on the asset’s network', () =>
    Effect.gen(function* () {
      const template = yield* buildSidequestEvent(paymentReceipt, receipt, { createdAt: 1_800_000_200 })
      expect(template.tags).toEqual(
        expect.arrayContaining([
          ['a', listing],
          ['e', event.id],
          ['p', publicKeyOf(bob)],
          ['sq-net', UsdcOnArcTestnet.network],
        ]),
      )
      const parsed = yield* parseSidequestEvent(paymentReceipt, sign(template, alice))
      expect(parsed.content).toEqual(receipt)
    }),
  )

  it.effect('refuses an unregistered asset, a payer on another network, a zero amount and a stray tag', () =>
    Effect.gen(function* () {
      const build = (content: PaymentReceiptContent) =>
        buildSidequestEvent(paymentReceipt, content, { createdAt: 1_800_000_200 })
      const decode = (input: object) => Schema.decodeUnknownEffect(PaymentReceiptContent)(input).pipe(Effect.orDie)
      expect(
        yield* outcome(
          build(
            yield* decode({ ...receipt, asset: 'eip155:5042002/erc20:0x0000000000000000000000000000000000000001' }),
          ),
        ),
      ).toBe('inconsistentContent')
      expect(yield* outcome(build(yield* decode({ ...receipt, payer: `eip155:8453:0x${'cd'.repeat(20)}` })))).toBe(
        'inconsistentContent',
      )
      expect(Schema.decodeUnknownExit(PaymentReceiptContent)({ ...receipt, amount: '0' })._tag).toBe('Failure')
      const template = yield* build(receipt)
      const stray = sign({ ...template, tags: [...template.tags, ['p', publicKeyOf(alice)]] }, alice)
      expect(yield* outcome(parseSidequestEvent(paymentReceipt, stray))).toBe('tagMismatch')
    }),
  )
})
