import { createHash, hkdfSync } from 'node:crypto'
import { Option, Result } from 'effect'
import { Hex } from 'effect/encoding'
import { describe, expect, test } from 'vitest'
import {
  firstValidKey,
  passkeyKeyAttempts,
  passkeyKeyCandidate,
  passkeyKeyInfo,
  passkeyPrfInput,
  publicKeyOf,
  secretKeyFromPrf,
} from '../src/index.ts'

// The derivation of a Nostr key from a passkey's PRF output (`PasskeyKey.ts`, ADR-0005). The vectors are fixed: a
// change to the input, the HKDF parameters or the counter rule changes every key people derived, and fails here.

const hex = (bytes: Uint8Array) => Hex.encode(bytes)

/** PRF outputs and the keys they derive (counter 0 in each), with their x-only public keys. */
const vectors = [
  {
    prf: Uint8Array.from({ length: 32 }, (_, index) => index),
    secret: '9c6fa2e8a18649291604b12133cbd82be73b282d8fadc62e7b98fde96f00d8b2',
    pubkey: 'c6c9f8212a83f4c9630f42303d8d6babb283ec2ce5e8b684c42adfea1aac311a',
  },
  {
    prf: new Uint8Array(32).fill(0xff),
    secret: '8a387ca4bd363e7ca1232842c197fc3205248a7693f79b1fa5b08d475a5f3909',
    pubkey: '88e158178f54fa28c0f1fb03e9b9f96a77e291b8208e8e9fbbacc2600fce7208',
  },
  {
    prf: new Uint8Array(32),
    secret: 'cbc2409b24dee82e0f95d277e9470c028ff5b8d54ff7d90e04128a05be331eb5',
    pubkey: '6d5a8081863a5940d52a9938085bc58c7f4aca98a69b8095471abd214e561a2b',
  },
]

/** secp256k1's group order n, which is not a secret key, and n − 1, the largest one. */
const order = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
const largest = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140'
const bytes = (text: string) => Option.getOrThrow(Result.getSuccess(Hex.decode(text)))

describe('a passkey-derived Nostr key', () => {
  test('evaluates the PRF at SHA-256 of the version label', () => {
    expect(hex(passkeyPrfInput())).toBe(createHash('sha256').update('sidequest/nostr-key/v1').digest('hex'))
    expect(hex(passkeyPrfInput())).toBe('0177faab18654d287d68c90efba6f1d7f65aa8a11637b01726d59125fc948f5a')
  })

  test('is HKDF-SHA256 of the PRF output with an empty salt and the versioned info, as another HKDF computes it', () => {
    for (const { prf } of vectors)
      for (const counter of [0, 1, 7])
        expect(hex(passkeyKeyCandidate(prf, counter))).toBe(
          hex(new Uint8Array(hkdfSync('sha256', prf, new Uint8Array(), passkeyKeyInfo(counter), 32))),
        )
    expect(passkeyKeyInfo(3)).toBe('sidequest/nostr-key/v1/secp256k1/3')
  })

  test('derives the committed vectors: the same PRF output always gives the same key', () => {
    for (const { prf, secret, pubkey } of vectors) {
      const derived = secretKeyFromPrf(prf)
      expect(derived).toEqual(Option.some(secret))
      expect(Option.map(derived, publicKeyOf)).toEqual(Option.some(pubkey))
    }
    expect(new Set(vectors.map(({ prf }) => Option.getOrNull(secretKeyFromPrf(prf)))).size).toBe(vectors.length)
  })

  test('skips a candidate that is not a scalar in [1, n − 1] and takes the next counter’s', () => {
    const candidates = [new Uint8Array(32), bytes(order), bytes(largest), bytes('11'.repeat(32))]
    const asked: Array<number> = []
    const derived = firstValidKey((counter) => {
      asked.push(counter)
      return candidates[counter] ?? new Uint8Array(32)
    })
    expect(derived).toEqual(Option.some(largest))
    expect(asked).toEqual([0, 1, 2])
  })

  test('gives none when no counter yields a scalar, and for a PRF output that is not 32 bytes', () => {
    expect(firstValidKey(() => bytes(order))).toEqual(Option.none())
    expect(passkeyKeyAttempts).toBe(256)
    expect(secretKeyFromPrf(new Uint8Array(31))).toEqual(Option.none())
    expect(secretKeyFromPrf(new Uint8Array(64))).toEqual(Option.none())
  })
})
