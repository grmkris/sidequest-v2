import { it } from '@effect/vitest'
import { SignInRefused, type SignInRefusal } from '@sidequest/protocol'
import { Effect } from 'effect'
import { createSiweMessage } from 'viem/siwe'
import { describe, expect } from 'vitest'
import { challengeMessage, checkMessage, siteOf } from '../src/SignIn/Siwe.ts'
import { ada, site } from './World.ts'

// 2026-11-12T10:00:00Z, as Unix seconds.
const now = 1794477600
const at = (seconds: number) => new Date(seconds * 1000)

/** A SIWE message Ada's wallet might be asked to sign, as a wallet library writes one; `fields` change it. */
const message = (fields: Partial<Parameters<typeof createSiweMessage>[0]> = {}) =>
  createSiweMessage({
    scheme: 'https',
    domain: 'sidequest.test',
    uri: 'https://sidequest.test',
    address: ada.address,
    version: '1',
    chainId: 5042002,
    nonce: 'n0nce0f16chars00',
    issuedAt: at(now),
    expirationTime: at(now + 300),
    ...fields,
  })

const refusal = (text: string, when = now) =>
  checkMessage(text, site, when).pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  )

describe('checkMessage', () => {
  it.effect('passes a message for this site on Arc testnet within its time, with its signer and nonce', () =>
    Effect.gen(function* () {
      expect(yield* checkMessage(message(), site, now)).toEqual({ address: ada.address, nonce: 'n0nce0f16chars00' })
      expect(yield* checkMessage(message({ expirationTime: undefined }), site, now + 360)).toEqual({
        address: ada.address,
        nonce: 'n0nce0f16chars00',
      })
      // A message without a scheme names https.
      expect(yield* checkMessage(message({ scheme: undefined }), site, now)).toMatchObject({ address: ada.address })
    }),
  )

  it.effect('passes the challenge the server writes', () =>
    Effect.gen(function* () {
      const challenge = yield* challengeMessage({
        site,
        address: ada.address,
        nonce: 'n0nce0f16chars00',
        issuedAt: now,
      })
      expect(challenge).toContain('sidequest.test wants you to sign in with your Ethereum account:')
      expect(challenge).toContain('Chain ID: 5042002')
      expect(yield* checkMessage(challenge, site, now)).toEqual({ address: ada.address, nonce: 'n0nce0f16chars00' })
    }),
  )

  const httpSite = siteOf(new URL('http://sidequest.test'))
  const refused: ReadonlyArray<{
    readonly name: string
    readonly text: string
    readonly reason: SignInRefusal
    readonly when?: number
    readonly to?: typeof site
  }> = [
    { name: 'text that is not a SIWE message', text: 'Sign in to Sidequest, please', reason: 'malformed' },
    { name: 'another SIWE version', text: message().replace('Version: 1', 'Version: 2'), reason: 'malformed' },
    {
      name: 'a message for another site',
      text: message({ domain: 'sidequest.example', uri: 'https://sidequest.example' }),
      reason: 'wrong_domain',
    },
    { name: 'a message for this host over another scheme', text: message({ scheme: 'http' }), reason: 'wrong_domain' },
    {
      name: 'a message without a scheme, which means https, at an http site',
      text: message({ scheme: undefined, uri: 'http://sidequest.test' }),
      reason: 'wrong_domain',
      to: httpSite,
    },
    {
      name: 'a message whose URI is another origin',
      text: message({ uri: 'https://evil.example/in' }),
      reason: 'wrong_uri',
    },
    { name: 'a message for another chain', text: message({ chainId: 1 }), reason: 'wrong_chain' },
    {
      name: 'a message issued over a minute ahead',
      text: message({ issuedAt: at(now + 61) }),
      reason: 'issued_in_future',
    },
    {
      name: 'a message issued longer ago than a challenge lives, with the skew',
      text: message({ expirationTime: undefined }),
      reason: 'stale',
      when: now + 361,
    },
    { name: 'a message not valid yet', text: message({ notBefore: at(now + 120) }), reason: 'not_yet_valid' },
    { name: 'a message at its expiration time', text: message(), reason: 'expired', when: now + 300 },
  ]

  for (const { name, text, reason, when = now, to = site } of refused)
    it.effect(`refuses ${name} as ${reason}`, () =>
      Effect.gen(function* () {
        const error = yield* checkMessage(text, to, when).pipe(Effect.flip)
        expect(error).toBeInstanceOf(SignInRefused)
        expect(error.reason).toBe(reason)
      }),
    )

  it.effect('accepts a message issued up to a minute ahead of the clock', () =>
    Effect.gen(function* () {
      expect(yield* checkMessage(message({ issuedAt: at(now + 60) }), site, now)).toMatchObject({
        nonce: 'n0nce0f16chars00',
      })
      expect(yield* refusal(message({ issuedAt: at(now + 60) }), now - 1)).toBe('issued_in_future')
    }),
  )
})
