import { publicKeyOf } from '@sidequest/nostr'
import { Redacted, Result, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { GatewaySecret, openKey, type SealedKey, sealKey } from '../src/Keys/KeyEnvelope.ts'
import { freshKey, secret } from './GatewayWorld.ts'

const entropy = {
  dataKey: new Uint8Array(32).fill(7),
  dataKeyNonce: new Uint8Array(24).fill(1),
  keyNonce: new Uint8Array(24).fill(2),
}

/** `hex` with the byte at `position` changed. */
const flipped = (hex: string, position: number) => {
  const at = position * 2
  const byte = (Number.parseInt(hex.slice(at, at + 2), 16) ^ 0x01).toString(16).padStart(2, '0')
  return `${hex.slice(0, at)}${byte}${hex.slice(at + 2)}`
}

describe('the key envelope', () => {
  const key = freshKey()
  const agent = publicKeyOf(key)
  const sealed = sealKey(secret, agent, key, entropy)

  test('opens what it sealed, with the same secret and agent', () => {
    expect(Result.getOrUndefined(openKey(secret, agent, sealed))).toBe(key)
  })

  test('stores nothing of the key in the clear', () => {
    expect(`${sealed.dataKeySealed}${sealed.keySealed}`).not.toContain(key)
  })

  test('refuses another secret', () => {
    const other = Redacted.make(Schema.decodeSync(GatewaySecret)('ab'.repeat(32)))
    expect(Result.isFailure(openKey(other, agent, sealed))).toBe(true)
  })

  test('refuses any altered byte of either seal, nonce or ciphertext', () => {
    for (const field of ['dataKeySealed', 'keySealed'] as const)
      for (const position of [0, 23, 24, 40, sealed[field].length / 2 - 1]) {
        const tampered: SealedKey = { ...sealed, [field]: flipped(sealed[field], position) }
        expect(Result.isFailure(openKey(secret, agent, tampered)), `${field}@${position}`).toBe(true)
      }
  })

  test('refuses a sealed key copied to another agent’s row', () => {
    expect(Result.isFailure(openKey(secret, publicKeyOf(freshKey()), sealed))).toBe(true)
  })

  test('binds each seal to its agent: another agent’s key under the same data key does not open', () => {
    const otherKey = freshKey()
    const other = publicKeyOf(otherKey)
    const theirs = sealKey(secret, other, otherKey, entropy)
    expect(Result.isFailure(openKey(secret, other, { ...theirs, keySealed: sealed.keySealed }))).toBe(true)
  })

  test('refuses an unknown version and a truncated seal', () => {
    expect(Result.isFailure(openKey(secret, agent, { ...sealed, version: 2 }))).toBe(true)
    expect(Result.isFailure(openKey(secret, agent, { ...sealed, keySealed: sealed.keySealed.slice(0, 40) }))).toBe(true)
  })
})
