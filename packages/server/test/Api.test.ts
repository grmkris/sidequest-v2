import { AccountRef, SessionView, Status } from '@sidequest/protocol'
import { Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { releaseFromEnvironment } from '../src/Status.ts'
import { ada, ben, origin, withApi } from './HttpWorld.ts'

// The typed HTTP API as a client sees it: requests in, responses out, over the model in memory and a local D1.

const post = (body: unknown, cookie?: string): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(cookie === undefined ? {} : { cookie }) },
  body: JSON.stringify(body),
})

const Challenge = Schema.Struct({ message: Schema.String, expiresAt: Schema.Number })
const Refusal = Schema.Struct({ _tag: Schema.String, reason: Schema.optional(Schema.String) })

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
  test('answers with the Status schema and the given release', () =>
    withApi(async ({ fetch }) => {
      const response = await fetch('/api/status')
      expect(response.status).toBe(200)
      expect(Schema.decodeUnknownSync(Status)(await response.json()).release).toBe('234a6c5')
    }))
})

describe('the session API', () => {
  test('signs a wallet in with a __Host- cookie, reads the session with it, and signs out', () =>
    withApi(async ({ fetch }) => {
      expect((await fetch('/api/session')).status).toBe(401)

      const challenge = await fetch('/api/session/challenge', post({ address: ada.address }))
      expect(challenge.status).toBe(200)
      const { message } = Schema.decodeUnknownSync(Challenge)(await challenge.json())
      expect(message).toContain(`sidequest.test wants you to sign in with your Ethereum account:\n${ada.address}`)
      expect(message).toContain(`URI: ${origin}`)

      const verified = await fetch(
        '/api/session/verify',
        post({ message, signature: await ada.signMessage({ message }) }),
      )
      expect(verified.status).toBe(200)
      const session = Schema.decodeUnknownSync(SessionView)(await verified.json())
      expect(session.wallet).toBe(AccountRef.make(`eip155:5042002:${ada.address}`))

      // A host-only cookie: no Domain, the whole site, HTTPS only, out of scripts' reach, not sent by other sites'
      // requests. `__Host-` makes browsers hold the server to that.
      const setCookie = verified.headers.get('set-cookie') ?? ''
      const [pair = '', ...attributes] = setCookie.split('; ')
      expect(pair).toMatch(/^__Host-sidequest-session=[0-9a-f]{64}$/)
      expect(attributes.toSorted()).toEqual(['HttpOnly', 'Max-Age=604800', 'Path=/', 'SameSite=Lax', 'Secure'])
      const cookie = pair

      const current = await fetch('/api/session', { headers: { cookie } })
      expect(current.status).toBe(200)
      expect(Schema.decodeUnknownSync(SessionView)(await current.json())).toEqual(session)

      const signedOut = await fetch('/api/session/sign-out', post({}, cookie))
      expect(signedOut.status).toBe(204)
      expect(signedOut.headers.get('set-cookie')).toMatch(/^__Host-sidequest-session=; Max-Age=0; Path=\/;/)
      expect((await fetch('/api/session', { headers: { cookie } })).status).toBe(401)
    }))

  test('refuses a message signed by another key, and a signature that is not hex', () =>
    withApi(async ({ fetch }) => {
      const challenge = await fetch('/api/session/challenge', post({ address: ada.address }))
      const { message } = Schema.decodeUnknownSync(Challenge)(await challenge.json())
      const forged = await fetch(
        '/api/session/verify',
        post({ message, signature: await ben.signMessage({ message }) }),
      )
      expect(forged.status).toBe(401)
      expect(forged.headers.get('set-cookie')).toBeNull()
      expect(Schema.decodeUnknownSync(Refusal)(await forged.json())).toEqual({
        _tag: 'SignInRefused',
        reason: 'bad_signature',
      })
      expect((await fetch('/api/session/verify', post({ message, signature: 'signed' }))).status).toBe(400)
    }))
})
