import { it } from '@effect/vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import { Result, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { bytesOf, hexOf } from '../src/Hex.ts'
import { PublicKey, publicKeyOf, SecretKey } from '../src/Keys.ts'
import { decryptNip44, encryptNip44, messageKeysOf, openWithMessageKeys } from '../src/Nip44.ts'
import { ConversationKey, conversationKey, messageKeys } from '../src/Nip44Keys.ts'
import { paddedLength } from '../src/Nip44Padding.ts'
import { entropy, GeneratedSecret, Hex32, secret, WellFormed } from './fixtures.ts'
import vectors from './vectors/nip44.vectors.json' with { type: 'json' }

// The official NIP-44 v2 vectors (paulmillr/nip44@671a1f04, nip44.vectors.json; see tools/provenance.json).
const { valid, invalid } = vectors.v2
const key = (hex: string) => ConversationKey.make(bytesOf(hex))
const sharedKey = (sec: string, pub: string) =>
  Result.map(conversationKey(secret(sec), PublicKey.make(pub)), hexOf).pipe(Result.getOrUndefined)
const refusal = <A>(result: Result.Result<A, { readonly reason: string }>) =>
  Result.match(result, { onSuccess: () => 'none', onFailure: (error) => error.reason })

describe('NIP-44 v2 keys', () => {
  test.each(valid.get_conversation_key)('derives the conversation key $conversation_key', (vector) => {
    expect(sharedKey(vector.sec1, vector.pub2)).toBe(vector.conversation_key)
  })

  test.each(invalid.get_conversation_key)('refuses: $note', (vector) => {
    const usable = Schema.is(SecretKey)(vector.sec1) && sharedKey(vector.sec1, vector.pub2) !== undefined
    expect(usable).toBe(false)
  })

  test.each(valid.get_message_keys.keys)('derives the message keys for nonce $nonce', (vector) => {
    const keys = messageKeys(key(valid.get_message_keys.conversation_key), entropy(vector.nonce))
    expect([hexOf(keys.chachaKey), hexOf(keys.chachaNonce), hexOf(keys.hmacKey)]).toEqual([
      vector.chacha_key,
      vector.chacha_nonce,
      vector.hmac_key,
    ])
  })

  test.each(valid.calc_padded_len)('pads %i bytes to %i', (length, padded) => {
    expect(paddedLength(length)).toBe(padded)
  })
})

describe('NIP-44 v2 encryption', () => {
  test.each(valid.encrypt_decrypt)('encrypts and decrypts $plaintext', (vector) => {
    const conversation = key(vector.conversation_key)
    expect(sharedKey(vector.sec1, publicKeyOf(secret(vector.sec2)))).toBe(vector.conversation_key)
    expect(Result.getOrUndefined(encryptNip44(vector.plaintext, conversation, entropy(vector.nonce)))).toBe(
      vector.payload,
    )
    expect(Result.getOrUndefined(decryptNip44(vector.payload, conversation))).toBe(vector.plaintext)
  })

  test.each(valid.encrypt_decrypt_long_msg)('encrypts $repeat repetitions of $pattern', (vector) => {
    const plaintext = vector.pattern.repeat(vector.repeat)
    expect(hexOf(sha256(new TextEncoder().encode(plaintext)))).toBe(vector.plaintext_sha256)
    const payload = Result.getOrElse(
      encryptNip44(plaintext, key(vector.conversation_key), entropy(vector.nonce)),
      () => '',
    )
    expect(hexOf(sha256(new TextEncoder().encode(payload)))).toBe(vector.payload_sha256)
    expect(Result.getOrUndefined(decryptNip44(payload, key(vector.conversation_key)))).toBe(plaintext)
  })

  test.each(invalid.encrypt_msg_lengths)('refuses a plaintext of %i bytes', (length) => {
    expect(refusal(encryptNip44('a'.repeat(length), key('00'.repeat(32)), entropy('01'.repeat(32))))).toBe(
      'plaintextLength',
    )
  })

  const expectedRefusal: Record<string, string> = {
    'unknown encryption version': 'unknownVersion',
    'unknown encryption version 0': 'unknownVersion',
    'invalid base64': 'badBase64',
    'invalid MAC': 'badMac',
    'invalid padding': 'badPadding',
  }

  test.each(invalid.decrypt)('refuses: $note', (vector) => {
    const expected = expectedRefusal[vector.note] ?? 'payloadLength'
    expect(refusal(decryptNip44(vector.payload, key(vector.conversation_key)))).toBe(expected)
  })

  test('refuses text UTF-8 cannot carry', () => {
    expect(refusal(encryptNip44('a\ud800', key('00'.repeat(32)), entropy('01'.repeat(32))))).toBe('notWellFormed')
  })

  it.prop(
    'decrypts what it encrypted, for either side of the conversation',
    [GeneratedSecret, GeneratedSecret, Hex32, WellFormed],
    ([one, other, nonce, plaintext]) => {
      const sender = Result.getOrUndefined(conversationKey(secret(one), publicKeyOf(secret(other))))
      const recipient = Result.getOrUndefined(conversationKey(secret(other), publicKeyOf(secret(one))))
      if (sender === undefined || recipient === undefined) return false
      const payload = Result.getOrElse(encryptNip44(plaintext, sender, entropy(nonce)), () => '')
      return Result.getOrUndefined(decryptNip44(payload, recipient)) === plaintext
    },
  )

  test('discloses one message: its keys open it, and they do not open another', () => {
    const conversation = key(valid.encrypt_decrypt[0]?.conversation_key ?? '')
    const first = Result.getOrElse(
      encryptNip44('the delivery was late', conversation, entropy('01'.repeat(32))),
      () => '',
    )
    const second = Result.getOrElse(encryptNip44('a private aside', conversation, entropy('02'.repeat(32))), () => '')
    const disclosed = Result.getOrUndefined(messageKeysOf(first, conversation))
    expect(disclosed === undefined ? undefined : Result.getOrUndefined(openWithMessageKeys(first, disclosed))).toBe(
      'the delivery was late',
    )
    expect(disclosed === undefined ? 'none' : refusal(openWithMessageKeys(second, disclosed))).toBe('badMac')
  })
})
