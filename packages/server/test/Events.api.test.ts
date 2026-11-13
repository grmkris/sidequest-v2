import { publicKeyOf } from '@sidequest/nostr'
import { Person, SameOrigin, SidequestApi, SignedEvent } from '@sidequest/protocol'
import { Schema } from 'effect'
import { HttpApi } from 'effect/http-api'
import { describe, expect, test } from 'vitest'
import { publishLimits } from '../src/Index/RateLimiter.ts'
import { eventLimits } from '../src/Index/Validation.ts'
import { type Api, bodyOf, withApi } from './HttpWorld.ts'
import { alice, bob, carol, keyOf, messagingRelays, profile, relayList, request, signed } from './IndexWorld.ts'

// Publish-through and the index's public reads, over HTTP: no session, no cookie; the event is its own authority.

const now = () => Math.floor(Date.now() / 1000)

/** POST one event as a client that is not a browser, from `address` as Cloudflare would report it. */
const publish = (fetch: Api['fetch'], event: unknown, headers: Record<string, string> = {}) =>
  fetch('/api/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.1', ...headers },
    body: JSON.stringify(event),
  })

const reply = async (response: Response) => {
  const body: unknown = await response.json()
  return { status: response.status, body }
}

describe('publishing a signed event', () => {
  test('stores it once and answers stored, then duplicate; anyone reads it back, cacheably', () =>
    withApi(async ({ fetch }) => {
      const event = profile(alice, now(), { name: 'Alice', about: 'Draws' })
      expect(await reply(await publish(fetch, event))).toEqual({
        status: 200,
        body: { id: event.id, status: 'stored' },
      })
      expect((await reply(await publish(fetch, event))).body).toEqual({ id: event.id, status: 'duplicate' })
      const read = await fetch(`/api/events/${event.id}`)
      expect(read.status).toBe(200)
      expect(Schema.decodeUnknownSync(SignedEvent)(await read.json())).toEqual(event)
      expect(read.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
      expect(await reply(await fetch(`/api/events/${'0'.repeat(64)}`))).toEqual({
        status: 404,
        body: { _tag: 'NotIndexed' },
      })
    }))

  test('serves what the index knows of a key: its latest profile and relay lists', () =>
    withApi(async ({ fetch, anonymous }) => {
      const pubkey = publicKeyOf(bob)
      expect((await anonymous.get(`/api/people/${pubkey}`)).status).toBe(404)
      const latest = profile(bob, now(), { name: 'Bob', picture: 'https://example.com/bob.png' })
      for (const event of [
        profile(bob, now() - 60, { name: 'Old Bob' }),
        latest,
        relayList(bob, now(), { read: ['wss://r.example.com'], write: ['wss://w.example.com'] }),
        messagingRelays(bob, now(), ['wss://dm.example.com']),
      ])
        expect((await publish(fetch, event)).status).toBe(200)
      const person = await fetch(`/api/people/${pubkey}`)
      expect(person.headers.get('cache-control')).toBe('public, max-age=60')
      expect(bodyOf(Person, await reply(person))).toMatchObject({
        pubkey,
        profile: { name: 'Bob', about: null, picture: 'https://example.com/bob.png', event: latest.id },
        relays: { read: ['wss://r.example.com'], write: ['wss://w.example.com'] },
        messagingRelays: { relays: ['wss://dm.example.com'] },
      })
    }))

  test('refuses with a typed reason: a bad signature, an unindexed kind, too large, or what the vocabulary refuses', () =>
    withApi(async ({ fetch }) => {
      const event = request(alice, now())
      expect(await reply(await publish(fetch, { ...event, sig: request(bob, now()).sig }))).toEqual({
        status: 400,
        body: { _tag: 'EventInvalid', reason: 'badSignature' },
      })
      expect(await reply(await publish(fetch, { ...event, content: 'changed' }))).toEqual({
        status: 400,
        body: { _tag: 'EventInvalid', reason: 'idMismatch' },
      })
      expect(
        await reply(await publish(fetch, signed({ created_at: now(), kind: 1, tags: [], content: 'hi' }))),
      ).toEqual({
        status: 422,
        body: { _tag: 'KindNotIndexed', kind: 1 },
      })
      const large = signed({ created_at: now(), kind: 0, tags: [], content: 'x'.repeat(eventLimits.contentLength + 1) })
      expect(await reply(await publish(fetch, large))).toEqual({ status: 413, body: { _tag: 'EventTooLarge' } })
      const stray = signed({ ...event, tags: [...event.tags, ['p', publicKeyOf(bob)]] })
      expect((await reply(await publish(fetch, stray))).body).toEqual({ _tag: 'EventInvalid', reason: 'tagMismatch' })
      expect((await publish(fetch, { kind: 0 })).status).toBe(400)
    }))
})

/**
 * Waits, when needed, until a fresh rate-limit window has at least 25 seconds left, so a test that fills one window is
 * not split across two (the window's own behaviour is proven against a test clock in `RateLimiter.test.ts`).
 */
const freshWindow = async () => {
  const left = publishLimits.perKey.windowSeconds - (Math.floor(Date.now() / 1000) % publishLimits.perKey.windowSeconds)
  if (left < 25) await new Promise((resolve) => setTimeout(resolve, left * 1000 + 50))
}

describe('the publish-through rate limit', () => {
  test('limits one key, once its signature verified, and no other key', { timeout: 60_000 }, () =>
    withApi(async ({ fetch }) => {
      await freshWindow()
      const statuses: Array<number> = []
      for (let index = 0; index <= publishLimits.perKey.limit; index += 1)
        statuses.push(
          (await publish(fetch, request(carol, now(), `Job ${index}`), { 'cf-connecting-ip': `198.51.100.${index}` }))
            .status,
        )
      expect(statuses.filter((status) => status === 200)).toHaveLength(publishLimits.perKey.limit)
      const limited = await reply(
        await publish(fetch, request(carol, now(), 'One more'), { 'cf-connecting-ip': '203.0.113.9' }),
      )
      expect(limited.status).toBe(429)
      expect(limited.body).toMatchObject({ _tag: 'RateLimited' })
      // An event in Carol's name with another key's signature is refused for its signature, before her limit is
      // consulted; and another key still publishes.
      const other = keyOf('5555555555555555555555555555555555555555555555555555555555555555')
      const forged = { ...request(carol, now(), 'Forged'), sig: request(other, now(), 'Forged').sig }
      expect((await reply(await publish(fetch, forged))).body).toEqual({ _tag: 'EventInvalid', reason: 'badSignature' })
      expect((await publish(fetch, request(other, now()))).status).toBe(200)
    }),
  )

  test('limits one client address, whatever it sends, and no other address', { timeout: 60_000 }, () =>
    withApi(async ({ fetch }) => {
      await freshWindow()
      const junk = { ...request(alice, now()), sig: 'not a signature' }
      for (let index = 0; index < publishLimits.perClient.limit; index += 1)
        expect((await publish(fetch, junk, { 'cf-connecting-ip': '192.0.2.77' })).status).toBe(400)
      const limited = await reply(await publish(fetch, request(alice, now()), { 'cf-connecting-ip': '192.0.2.77' }))
      expect(limited).toMatchObject({ status: 429, body: { _tag: 'RateLimited' } })
      expect((await publish(fetch, request(alice, now()), { 'cf-connecting-ip': '192.0.2.78' })).status).toBe(200)
    }),
  )
})

describe('the same-origin rule', () => {
  test('does not apply to publishing an event: another site may publish one, as its author could', () =>
    withApi(async ({ fetch }) => {
      const event = request(alice, now())
      const crossSite = await publish(fetch, event, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })
      expect(await reply(crossSite)).toEqual({ status: 200, body: { id: event.id, status: 'stored' } })
    }))

  test('still guards every other endpoint of the API', () =>
    withApi(async ({ fetch }) => {
      const unguarded: Array<string> = []
      HttpApi.reflect(SidequestApi, {
        onGroup: () => undefined,
        onEndpoint: ({ endpoint, middleware }) => {
          if (!Array.from(middleware, ({ key }) => key).includes(SameOrigin.key))
            unguarded.push(`${endpoint.method} ${endpoint.path}`)
        },
      })
      expect(unguarded.toSorted()).toEqual(['GET /api/events/:id', 'GET /api/people/:pubkey', 'POST /api/events'])
      // And it is the middleware that runs: a cross-site state change elsewhere is still refused.
      const forged = await fetch('/api/session/challenge', {
        method: 'POST',
        headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
        body: JSON.stringify({ address: '0x0000000000000000000000000000000000000001' }),
      })
      expect(await reply(forged)).toEqual({ status: 403, body: { _tag: 'CrossSiteRequest' } })
    }))
})
