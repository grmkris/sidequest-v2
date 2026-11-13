import { it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import { describe, expect } from 'vitest'
import type { EventTemplate } from '../src/Event.ts'
import { publicKeyOf } from '../src/Keys.ts'
import { ListingSlug } from '../src/ListingAddress.ts'
import { parseServiceListing, ServiceListing, serviceListingTemplate } from '../src/ServiceListing.ts'
import { finalizeEvent } from '../src/Sign.ts'
import { bob, zeros } from './fixtures.ts'

const listing = Schema.decodeSync(ServiceListing)({
  slug: 'logo-design',
  title: 'Logo design',
  summary: 'A logo in three days',
  description: 'I draw **logos**.',
  topics: ['design', 'logo'],
  price: { amount: '1500000', asset: 'eip155:5042002/erc20:0x3600000000000000000000000000000000000000' },
  status: 'active',
  publishedAt: 1_800_000_000,
})
const sign = (template: EventTemplate) => finalizeEvent(template, bob, zeros)
const outcome = (input: unknown) =>
  parseServiceListing(input).pipe(
    Effect.map(() => 'accepted'),
    Effect.catch((error) => Effect.succeed(error.reason)),
  )

// Listings without a price and with generated text, so the round trip is not only the one example.
const Generated = Schema.Struct({
  slug: ListingSlug,
  title: ServiceListing.fields.title,
  summary: ServiceListing.fields.summary,
  description: ServiceListing.fields.description,
  topics: ServiceListing.fields.topics,
  status: ServiceListing.fields.status,
  publishedAt: ServiceListing.fields.publishedAt,
})

describe('a service listing on NIP-99', () => {
  it.effect('is a NIP-99 classified with its price in whole units, and the exact price beside it', () =>
    Effect.gen(function* () {
      const event = sign(serviceListingTemplate(listing, 1_800_000_100))
      expect(event.kind).toBe(30_402)
      expect(event.content).toBe('I draw **logos**.')
      expect(event.tags).toEqual(
        expect.arrayContaining([
          ['d', 'logo-design'],
          ['title', 'Logo design'],
          ['summary', 'A logo in three days'],
          ['published_at', '1800000000'],
          ['price', '1.5', 'USDC'],
          ['sq-price', '1500000', 'eip155:5042002/erc20:0x3600000000000000000000000000000000000000'],
          ['status', 'active'],
          ['t', 'design'],
          ['sq', '2'],
        ]),
      )
      const parsed = yield* parseServiceListing(event)
      expect(parsed.listing).toEqual(listing)
      expect(parsed.address).toBe(`30402:${publicKeyOf(bob)}:logo-design`)
    }),
  )

  it.effect.prop('reads back any listing it writes', [Generated], ([generated]) =>
    parseServiceListing(sign(serviceListingTemplate(generated, 1_800_000_100))).pipe(
      Effect.map((parsed) => Schema.toEquivalence(ServiceListing)(parsed.listing, generated)),
    ),
  )

  it.effect(
    'refuses a price tag that disagrees with the exact price, an unregistered asset, and stray routing tags',
    () =>
      Effect.gen(function* () {
        const event = sign(serviceListingTemplate(listing, 1_800_000_100))
        const retag = (tags: EventTemplate['tags']) => sign({ ...event, tags })
        expect(
          yield* outcome(retag(event.tags.map((tag) => (tag[0] === 'price' ? ['price', '15', 'USDC'] : tag)))),
        ).toBe('tagMismatch')
        const elsewhere = event.tags.map((tag) =>
          tag[0] === 'sq-price' ? ['sq-price', '1', 'eip155:1/erc20:0xabc'] : tag,
        )
        expect(yield* outcome(retag(elsewhere))).toBe('badContent')
        expect(yield* outcome(retag([...event.tags, ['e', 'aa'.repeat(32)]]))).toBe('tagMismatch')
        expect(yield* outcome(retag([...event.tags, ['published_at', '1']]))).toBe('tagMismatch')
        expect(yield* outcome(retag(event.tags.filter((tag) => tag[0] !== 'sq')))).toBe('badEnvelope')
        expect(yield* outcome(sign({ ...event, kind: 30_403 }))).toBe('wrongKind')
      }),
  )

  it.effect('reads a listing another NIP-99 client decorated with its own tags', () =>
    Effect.gen(function* () {
      const event = sign(serviceListingTemplate(listing, 1_800_000_100))
      const decorated = sign({
        ...event,
        tags: [...event.tags, ['location', 'Ljubljana'], ['image', 'https://example.com/a.png'], ['client', 'x']],
      })
      expect((yield* parseServiceListing(decorated)).listing).toEqual(listing)
    }),
  )
})
