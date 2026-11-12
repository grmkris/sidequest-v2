import { SignInChallenge } from '@sidequest/protocol'
import { Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { ada, type Api, origin, withApi } from './HttpWorld.ts'

// The rule every state-changing request meets (`fromThisSite`): from this site, or from no browser with a JSON body.
// The sign-in endpoints show it, since a forged sign-in is what the session cookie's `SameSite=Lax` alone left open.

const challengeFor = (fetch: Api['fetch'], headers: Record<string, string>, body = { address: ada.address }) =>
  fetch('/api/session/challenge', { method: 'POST', headers, body: JSON.stringify(body) })

const json = { 'content-type': 'application/json' }

describe('a state-changing request', () => {
  test('passes from this origin, or with no Origin and a JSON body (a client that is not a browser)', () =>
    withApi(async ({ fetch }) => {
      expect((await challengeFor(fetch, { ...json, origin })).status).toBe(200)
      expect((await challengeFor(fetch, json)).status).toBe(200)
      expect((await challengeFor(fetch, { ...json, 'sec-fetch-site': 'same-origin' })).status).toBe(200)
    }))

  test('is refused from another origin, a sibling subdomain, another port or scheme, or an opaque origin', () =>
    withApi(async ({ fetch }) => {
      for (const foreign of [
        'https://evil.example',
        'https://app.sidequest.test',
        'https://sidequest.test:8443',
        'http://sidequest.test',
        'null',
      ]) {
        const refused = await challengeFor(fetch, { ...json, origin: foreign })
        expect(refused.status).toBe(403)
        expect(await refused.json()).toEqual({ _tag: 'CrossSiteRequest' })
      }
    }))

  test('is refused without Origin when a browser says it is cross-site, or when its body is not JSON', () =>
    withApi(async ({ fetch }) => {
      for (const site of ['cross-site', 'same-site', 'none'])
        expect((await challengeFor(fetch, { ...json, 'sec-fetch-site': site })).status).toBe(403)
      // What a cross-site form can send: no preflight, so the server must refuse it itself.
      expect((await challengeFor(fetch, { 'content-type': 'text/plain' })).status).toBe(403)
      expect((await fetch('/api/session/sign-out', { method: 'POST' })).status).toBe(403)
    }))

  test('cannot sign anyone in from another site, even with a valid signature', () =>
    withApi(async ({ fetch }) => {
      const { message } = Schema.decodeUnknownSync(SignInChallenge)(
        await (await challengeFor(fetch, { ...json, origin })).json(),
      )
      const signature = await ada.signMessage({ message })
      const verifyFrom = (from: string) =>
        fetch('/api/session/verify', {
          method: 'POST',
          headers: { ...json, origin: from },
          body: JSON.stringify({ message, signature }),
        })
      const forged = await verifyFrom('https://evil.example')
      expect(forged.status).toBe(403)
      expect(forged.headers.get('set-cookie')).toBeNull()
      // The refused attempt spent nothing: the same signed message still signs Ada in from her own site.
      const own = await verifyFrom(origin)
      expect(own.status).toBe(200)
      expect(own.headers.get('set-cookie')).toMatch(/^__Host-sidequest-session=/)
    }))

  test('a safe method passes from anywhere: reading changes nothing', () =>
    withApi(async ({ fetch }) => {
      const read = await fetch('/api/status', {
        headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
      })
      expect(read.status).toBe(200)
    }))
})
