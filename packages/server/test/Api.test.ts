import { ServedApi } from '@sidequest/fold/api'
import { Status } from '@sidequest/protocol'
import { Schema } from 'effect'
import { HttpApi } from 'effect/http-api'
import { describe, expect, test } from 'vitest'
import { releaseFromEnvironment } from '../src/Status.ts'
import { withApi } from './HttpWorld.ts'

// The typed HTTP API as a client sees it: requests in, responses out, over the index on a local D1.

describe('releaseFromEnvironment', () => {
  test('uses the deployment release when present', () => {
    expect(releaseFromEnvironment({ SIDEQUEST_RELEASE: '234a6c5' })).toBe('234a6c5')
  })

  test('falls back for missing or empty releases', () => {
    expect(releaseFromEnvironment({})).toBe('local-build')
    expect(releaseFromEnvironment({ SIDEQUEST_RELEASE: '' })).toBe('local-build')
  })
})

describe('GET /api/status', () => {
  test('answers with the Status schema, the given release and phase 2’s protocol', () =>
    withApi(async ({ fetch }) => {
      const response = await fetch('/api/status')
      expect(response.status).toBe(200)
      expect(Schema.decodeUnknownSync(Status)(await response.json())).toMatchObject({
        release: '234a6c5',
        protocolVersion: '0.3-phase2',
      })
    }))
})

/** Every endpoint the API serves, as `METHOD /path`. */
const endpoints = () => {
  const found: Array<string> = []
  HttpApi.reflect(ServedApi, {
    onGroup: () => undefined,
    onEndpoint: ({ endpoint }) => {
      found.push(`${endpoint.method} ${endpoint.path}`)
    },
  })
  return found.toSorted()
}

describe('what the API reads as authority', () => {
  test('serves no session, account or agent endpoint: every state change carries its own signature', () => {
    expect(endpoints().filter((endpoint) => !endpoint.startsWith('GET '))).toEqual([
      // The hide list: a NIP-98 authorization by the stage's moderator key.
      'DELETE /api/moderation/hidden/:target',
      // A Nostr event, signed by its author.
      'POST /api/events',
      // The escrow: each carries a wallet signature the contract verifies (the ruling, a NIP-98 authorization).
      'POST /api/index/jobs/:id/approval',
      'POST /api/index/jobs/:id/delegated-delivery',
      'POST /api/index/jobs/:id/delivery',
      'POST /api/index/jobs/:id/proposals/:proposal/funding',
      'POST /api/index/jobs/:id/rejection',
      'POST /api/index/jobs/:id/ruling',
      'PUT /api/moderation/hidden/:target',
    ])
    // Phase 1's groups are gone; the index's own reads (`/api/index/…`, `/api/people`, `/api/wallets`) remain.
    for (const endpoint of endpoints())
      expect(endpoint).not.toMatch(/ \/api\/(session|account|agents|connect|inbox|rooms|listings|jobs|settlement)\b/u)
  })

  test('ignores a cookie: a request with one is answered exactly as one without', () =>
    withApi(async ({ fetch }) => {
      const event = '0'.repeat(64)
      const plain = await fetch(`/api/events/${event}`)
      const withCookie = await fetch(`/api/events/${event}`, {
        headers: { cookie: '__Host-sidequest-session=' + 'ab'.repeat(32) },
      })
      expect([withCookie.status, await withCookie.json()]).toEqual([plain.status, await plain.json()])
      expect(withCookie.headers.get('set-cookie')).toBeNull()
    }))
})

describe('requests from another origin', () => {
  const foreign = { origin: 'https://elsewhere.example', 'sec-fetch-site': 'cross-site' }

  test('are served like any other, and answered without CORS headers', () =>
    withApi(async ({ fetch }) => {
      const read = await fetch('/api/status', { headers: foreign })
      expect(read.status).toBe(200)
      const posted = await fetch('/api/events', {
        method: 'POST',
        headers: { ...foreign, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      // Refused for what it is (not a signed event), never for where it came from.
      expect(posted.status).toBe(400)
      for (const response of [read, posted])
        expect([...response.headers.keys()].filter((name) => name.startsWith('access-control-'))).toEqual([])
    }))

  test('get no CORS preflight granted, so a page on another origin cannot send JSON or read an answer', () =>
    withApi(async ({ fetch }) => {
      const preflight = await fetch('/api/events', {
        method: 'OPTIONS',
        headers: {
          ...foreign,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      })
      expect(preflight.headers.get('access-control-allow-origin')).toBeNull()
      expect(preflight.headers.get('access-control-allow-methods')).toBeNull()
    }))
})
