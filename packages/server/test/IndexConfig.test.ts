import { Option, Result } from 'effect'
import { describe, expect, test } from 'vitest'
import { defaultOverlapSeconds, indexConfigFrom } from '../src/Index/IndexConfig.ts'
import { relayUrlOf } from '../src/Index/RelayUrls.ts'

describe('a relay URL', () => {
  test('is allowed as wss to a public host name', () => {
    expect(relayUrlOf('wss://relay.damus.io', 'public')).toEqual(Option.some('wss://relay.damus.io/'))
    expect(relayUrlOf(' wss://Nos.LOL/inbox ', 'public')).toEqual(Option.some('wss://nos.lol/inbox'))
  })

  test('is refused as ws, http, an IP literal, localhost, a private name, or with credentials', () => {
    for (const url of [
      'ws://relay.damus.io',
      'https://relay.damus.io',
      'wss://127.0.0.1',
      'wss://10.0.0.8:7777',
      'wss://[::1]',
      'wss://localhost',
      'wss://relay.localhost',
      'wss://nas.local',
      'wss://relay.internal',
      'wss://user:pass@relay.damus.io',
      'wss://relay',
      'not a url',
    ])
      expect(relayUrlOf(url, 'public')).toEqual(Option.none())
  })

  test('may be the local test relay only under the test policy', () => {
    expect(relayUrlOf('ws://127.0.0.1:4848', 'public')).toEqual(Option.none())
    expect(relayUrlOf('ws://127.0.0.1:4848', 'local')).toEqual(Option.some('ws://127.0.0.1:4848/'))
    expect(relayUrlOf('ws://10.0.0.8:4848', 'local')).toEqual(Option.none())
  })
})

describe('the index configuration', () => {
  test('is idle by default: no relays at all', () => {
    const config = indexConfigFrom({})
    expect(Result.isSuccess(config) && config.success).toMatchObject({
      relays: [],
      policy: 'public',
      overlapSeconds: defaultOverlapSeconds,
    })
    expect(defaultOverlapSeconds).toBe(2 * 86_400 + 15 * 60)
  })

  test('reads relays, the overlap and a service key', () => {
    const config = indexConfigFrom({
      SIDEQUEST_RELAYS: 'wss://relay.damus.io, wss://nos.lol',
      SIDEQUEST_RELAY_OVERLAP_SECONDS: '600',
      SIDEQUEST_INDEX_KEY: '44'.repeat(32),
    })
    expect(Result.isSuccess(config) && config.success).toMatchObject({
      relays: ['wss://relay.damus.io/', 'wss://nos.lol/'],
      overlapSeconds: 600,
      authKey: Option.some('44'.repeat(32)),
    })
  })

  test('names every malformed variable, and never accepts a relay the rule refuses', () => {
    const config = indexConfigFrom({
      SIDEQUEST_RELAYS: 'wss://relay.damus.io,ws://localhost:7777',
      SIDEQUEST_RELAY_OVERLAP_SECONDS: '-1',
      SIDEQUEST_INDEX_KEY: 'nope',
    })
    expect(Result.isFailure(config) && config.failure.names).toEqual([
      'SIDEQUEST_RELAYS',
      'SIDEQUEST_RELAY_OVERLAP_SECONDS',
      'SIDEQUEST_INDEX_KEY',
    ])
  })
})
