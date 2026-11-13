import { it } from '@effect/vitest'
import { Effect, Result, Schema } from 'effect'
import { describe, expect } from 'vitest'
import { decodeBech32, encodeBech32 } from '../src/Bech32.ts'
import { bytesOf } from '../src/Hex.ts'
import { encodeNsec } from '../src/Nip19.ts'
import { decryptNip49, encryptNip49, KeySecurity, Nip49Nonce, Nip49Salt } from '../src/Nip49.ts'
import { alice, GeneratedSecret, secret } from './fixtures.ts'

// The example in NIP-49 (nostr-protocol/nips, 49.md › Test Data): password `nostr`, log_n 16.
const specExample =
  'ncryptsec1qgg9947rlpvqu76pj5ecreduf9jxhselq2nae2kghhvd5g7dgjtcxfqtd67p9m0w57lspw8gsq6yphnm8623nsl8xn9j4jdzz84zm3frztj3z7s35vpzmqf6ksu8r89qk5z2zxfmu5gv8th8wclt0h4p'
const specSecret = '3501454135014541350145413501453fefb02227e449e57cf4d3a3ce05378683'

const salt = Nip49Salt.make(bytesOf('11'.repeat(16)))
const nonce = Nip49Nonce.make(bytesOf('22'.repeat(24)))
// A small cost keeps the properties fast; the spec's example runs at the common 16.
const cheap = { logN: 2, keySecurity: 'secure', salt, nonce } as const

/** The 91 bytes of an `ncryptsec`, to alter; none for a string that is not bech32. */
const payloadOf = (text: string) =>
  Uint8Array.from(Result.match(decodeBech32(text), { onSuccess: ({ bytes }) => bytes, onFailure: () => [] }))

const reasonOf = (effect: Effect.Effect<unknown, { readonly reason: string }>) =>
  Effect.map(Effect.flip(effect), (error) => error.reason)

describe('NIP-49: a secret key encrypted with a password', () => {
  it.effect('opens the spec’s example with its password', () =>
    Effect.gen(function* () {
      const opened = yield* decryptNip49(specExample, 'nostr')
      expect(opened).toEqual({ secret: specSecret, logN: 16, keySecurity: 'insecure' })
    }),
  )

  it.effect('refuses the spec’s example under another password, or with one character changed', () =>
    Effect.gen(function* () {
      expect(yield* reasonOf(decryptNip49(specExample, 'nostR'))).toBe('wrongPassword')
      const tampered = payloadOf(specExample)
      tampered[60] = (tampered[60] ?? 0) ^ 1
      expect(yield* reasonOf(decryptNip49(encodeBech32('ncryptsec', tampered), 'nostr'))).toBe('wrongPassword')
    }),
  )

  it.effect.prop(
    'round-trips any key, password and key-security byte',
    [GeneratedSecret, Schema.String.check(Schema.isMaxLength(64)), KeySecurity],
    ([key, password, keySecurity]) =>
      Effect.gen(function* () {
        const ncryptsec = yield* encryptNip49(secret(key), password, { ...cheap, keySecurity })
        expect(ncryptsec.startsWith('ncryptsec1')).toBe(true)
        expect(yield* decryptNip49(ncryptsec, password)).toEqual({ secret: key, logN: 2, keySecurity })
      }),
  )

  it.effect('normalizes the password to NFKC, as the spec’s example of ÅΩẛ̣ shows', () =>
    Effect.gen(function* () {
      // U+212B U+2126 U+1E9B U+0323 and its NFKC form U+00C5 U+03A9 U+1E69.
      const composed = yield* encryptNip49(alice, 'ÅΩẛ̣', cheap)
      expect(yield* encryptNip49(alice, 'ÅΩṩ', cheap)).toBe(composed)
      expect((yield* decryptNip49(composed, 'ÅΩṩ')).secret).toBe(alice)
    }),
  )

  it.effect('authenticates the key-security byte with the ciphertext', () =>
    Effect.gen(function* () {
      const relabelled = payloadOf(yield* encryptNip49(alice, 'pw', cheap))
      relabelled[42] = 0x00
      expect(yield* reasonOf(decryptNip49(encodeBech32('ncryptsec', relabelled), 'pw'))).toBe('wrongPassword')
      relabelled[42] = 0x07
      expect(yield* reasonOf(decryptNip49(encodeBech32('ncryptsec', relabelled), 'pw'))).toBe('unknownKeySecurity')
    }),
  )

  it.effect('refuses what is not an ncryptsec, another version, and a cost above the ceiling before any work', () =>
    Effect.gen(function* () {
      expect(yield* reasonOf(decryptNip49(encodeNsec(alice), 'pw'))).toBe('notNcryptsec')
      expect(yield* reasonOf(decryptNip49('not bech32 at all', 'pw'))).toBe('notNcryptsec')
      const bytes = payloadOf(yield* encryptNip49(alice, 'pw', cheap))
      expect(yield* reasonOf(decryptNip49(encodeBech32('ncryptsec', bytes.subarray(0, 90)), 'pw'))).toBe('notNcryptsec')
      bytes[0] = 0x01
      expect(yield* reasonOf(decryptNip49(encodeBech32('ncryptsec', bytes), 'pw'))).toBe('unknownVersion')
      bytes[0] = 0x02
      // 2^40 rounds would ask for a terabyte; it is refused, not attempted.
      bytes[1] = 40
      expect(yield* reasonOf(decryptNip49(encodeBech32('ncryptsec', bytes), 'pw'))).toBe('cost')
      bytes[1] = 2
      expect(yield* reasonOf(decryptNip49(encodeBech32('ncryptsec', bytes), 'pw', 1))).toBe('cost')
      expect(yield* reasonOf(encryptNip49(alice, 'pw', { ...cheap, logN: 0 }))).toBe('cost')
      expect(yield* reasonOf(encryptNip49(alice, 'pw', { ...cheap, logN: 21 }))).toBe('cost')
    }),
  )
})
