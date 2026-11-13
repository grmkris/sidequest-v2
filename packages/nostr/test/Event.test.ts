import { readFileSync } from 'node:fs'
import { it } from '@effect/vitest'
import { Result, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import type { NostrEvent } from '../src/Event.ts'
import { bytesOf, hexOf } from '../src/Hex.ts'
import { publicKeyOf } from '../src/Keys.ts'
import { schnorrSign, schnorrVerify } from '../src/Schnorr.ts'
import { finalizeEvent } from '../src/Sign.ts'
import { verifyEvent } from '../src/Verify.ts'
import {
  entropy,
  GeneratedSecret,
  Hex32,
  nip59Example,
  nip98Example,
  relayNote,
  replaceAt,
  secret,
} from './fixtures.ts'

// BIP-340's own vectors (bitcoin/bips@b34d9f75, bip-0340/test-vectors.csv; see tools/provenance.json).
const bip340 = readFileSync(new URL('vectors/bip340.csv', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .slice(1)
  .map((line) => {
    const [index = '', secretKey = '', publicKey = '', auxRand = '', message = '', signature = '', valid = ''] =
      line.split(',')
    return { index, secretKey, publicKey, auxRand, message, signature, valid: valid === 'TRUE' }
  })

describe('BIP-340', () => {
  test('reads all 19 official vectors', () => {
    expect(bip340).toHaveLength(19)
  })

  test.each(bip340.filter((vector) => vector.secretKey !== ''))('signs vector $index', (vector) => {
    const signature = schnorrSign(
      bytesOf(vector.message),
      secret(vector.secretKey.toLowerCase()),
      entropy(vector.auxRand.toLowerCase()),
    )
    expect(hexOf(signature)).toBe(vector.signature.toLowerCase())
    expect(publicKeyOf(secret(vector.secretKey.toLowerCase()))).toBe(vector.publicKey.toLowerCase())
  })

  test.each(bip340)('verifies vector $index as $valid', (vector) => {
    expect(schnorrVerify(bytesOf(vector.signature), bytesOf(vector.message), bytesOf(vector.publicKey))).toBe(
      vector.valid,
    )
  })

  test('refuses inputs of the wrong length instead of throwing', () => {
    expect(schnorrVerify(new Uint8Array(63), new Uint8Array(32), new Uint8Array(32))).toBe(false)
    expect(schnorrVerify(new Uint8Array(64), new Uint8Array(32), new Uint8Array(31))).toBe(false)
  })
})

const reason = (input: unknown) =>
  Result.match(verifyEvent(input), { onSuccess: () => 'valid', onFailure: (e) => e.reason })

describe('verifying events', () => {
  test('accepts events signed by other implementations', () => {
    expect(reason(relayNote)).toBe('valid')
    expect(reason(nip59Example.seal)).toBe('valid')
    expect(reason(nip59Example.wrap)).toBe('valid')
  })

  test('refuses the NIP-98 example, whose id is not the hash of its fields', () => {
    expect(reason(nip98Example)).toBe('idMismatch')
  })

  test('refuses what is not an event, a carried id that is not the hash, and a signature that fails', () => {
    expect(reason({ ...relayNote, kind: 70_000 })).toBe('malformed')
    expect(reason({ ...relayNote, pubkey: relayNote.pubkey.toUpperCase() })).toBe('malformed')
    expect(reason('not an event')).toBe('malformed')
    expect(reason({ ...relayNote, id: nip98Example.id })).toBe('idMismatch')
    expect(reason({ ...relayNote, sig: nip98Example.sig })).toBe('badSignature')
  })

  // Expected id from `printf '%s' '[0,"<pubkey>",1,1,[],"a\"\\\n\t\u0001é"]' | sha256sum`: the short escapes NIP-01
  // names, \u0001 for another control character, and é as UTF-8.
  test('hashes the NIP-01 serialization with its escapes', () => {
    const event = finalizeEvent(
      { created_at: 1, kind: 1, tags: [], content: 'a"\\\n\t\u0001é' },
      secret('0000000000000000000000000000000000000000000000000000000000000003'),
      entropy('00'.repeat(32)),
    )
    expect(event.id).toBe('ffb6084ecd0a2880bac54445e42a63f7194c1c31ae1d4bc11fde3783aee731b1')
  })
})

const Template = Schema.Struct({
  created_at: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 ** 32 })),
  kind: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65_535 })),
  tags: Schema.Array(Schema.Array(Schema.String).check(Schema.isMinLength(1))),
  content: Schema.String,
})

describe('signing', () => {
  it.prop(
    'signs any template so that it verifies as its key',
    [GeneratedSecret, Hex32, Template],
    ([key, aux, template]) => {
      const event = finalizeEvent(template, secret(key), entropy(aux))
      return Result.isSuccess(verifyEvent(event)) && event.pubkey === publicKeyOf(secret(key))
    },
  )

  const tamperings: Record<string, (event: NostrEvent, position: number) => unknown> = {
    id: (event, position) => ({ ...event, id: replaceAt(event.id, position) }),
    sig: (event, position) => ({ ...event, sig: replaceAt(event.sig, position) }),
    content: (event, position) => ({ ...event, content: replaceAt(event.content, position) }),
    tag: (event, position) => ({
      ...event,
      tags: event.tags.map((tag, index) => (index === 0 ? tag.map((value) => replaceAt(value, position)) : tag)),
    }),
    created_at: (event) => ({ ...event, created_at: event.created_at + 1 }),
    kind: (event) => ({ ...event, kind: (event.kind + 1) % 65_536 }),
  }

  it.prop(
    'refuses an event with any one character of its id, signature, content or a tag changed',
    [
      GeneratedSecret,
      Template,
      Schema.Literals(['id', 'sig', 'content', 'tag', 'created_at', 'kind']),
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 200 })),
    ],
    ([key, template, field, position]) => {
      const event = finalizeEvent(
        { ...template, tags: [['t', 'x'], ...template.tags] },
        secret(key),
        entropy('00'.repeat(32)),
      )
      return Result.isFailure(verifyEvent(tamperings[field]?.(event, position)))
    },
  )
})
