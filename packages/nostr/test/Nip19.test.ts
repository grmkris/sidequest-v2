import { it } from '@effect/vitest'
import { Result, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { decodeBech32, encodeBech32 } from '../src/Bech32.ts'
import { EventId } from '../src/Event.ts'
import { bytesOf } from '../src/Hex.ts'
import { PublicKey, publicKeyOf } from '../src/Keys.ts'
import { decodeNip19, encodeNote, encodeNpub, encodeNsec } from '../src/Nip19.ts'
import { GeneratedSecret, Hex32, secret } from './fixtures.ts'

const decoded = (text: string) => Result.getOrUndefined(decodeNip19(text))
const refusal = (text: string) =>
  Result.match(decodeBech32(text), { onSuccess: () => 'valid', onFailure: (error) => error.reason })

describe('NIP-19', () => {
  // The examples in NIP-19 (nostr-protocol/nips@1fb3a95f, 19.md).
  test.each([
    [
      'npub',
      'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg',
      '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e',
    ],
    [
      'npub',
      'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6',
      '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d',
    ],
    [
      'nsec',
      'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5',
      '67dea2ed018072d675f5415ecfaed7d2597555e202d85b3d65ea4e58d2d92ffa',
    ],
  ])('reads and writes the spec’s %s example', (type, text, hex) => {
    expect(decoded(text)).toEqual({ type, data: hex })
    expect(type === 'npub' ? encodeNpub(PublicKey.make(hex)) : encodeNsec(secret(hex))).toBe(text)
  })

  // Jack's key as his clients show it.
  test('names a known person by their npub', () => {
    expect(encodeNpub(PublicKey.make('82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2'))).toBe(
      'npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m',
    )
  })

  it.prop('round-trips any key and id', [GeneratedSecret, Hex32], ([key, id]) => {
    const keyed = secret(key)
    return (
      decoded(encodeNsec(keyed))?.data === keyed &&
      decoded(encodeNpub(publicKeyOf(keyed)))?.data === publicKeyOf(keyed) &&
      decoded(encodeNote(EventId.make(id)))?.data === id
    )
  })

  test('refuses entities it does not read, and a secret that is not a scalar', () => {
    expect(Result.isFailure(decodeNip19(encodeBech32('nprofile', new Uint8Array(32))))).toBe(true)
    expect(Result.isFailure(decodeNip19(encodeBech32('npub', new Uint8Array(31))))).toBe(true)
    expect(Result.isFailure(decodeNip19(encodeBech32('nsec', new Uint8Array(32))))).toBe(true)
    expect(Result.isFailure(decodeNip19(encodeBech32('nsec', bytesOf('ff'.repeat(32)))))).toBe(true)
  })
})

describe('bech32', () => {
  // BIP-173's valid checksums (bitcoin/bips, bip-0173.mediawiki › Test vectors).
  test.each([
    'A12UEL5L',
    'a12uel5l',
    'an83characterlonghumanreadablepartthatcontainsthenumber1andtheexcludedcharactersbio1tt5tgs',
    'abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw',
    `11${'q'.repeat(82)}c8247j`,
    'split1checkupstagehandshakeupstreamerranterredcaperred2y9e3w',
    '?1ezyfcl',
  ])('accepts %s and writes it back in lower case', (text) => {
    const result = Result.getOrUndefined(decodeBech32(text))
    expect(result === undefined ? undefined : encodeBech32(result.prefix, result.bytes)).toBe(text.toLowerCase())
  })

  // BIP-173's invalid strings, less the 90-character limit NIP-19 lifts.
  test.each([
    ['\x201nwldj5', 'badCharacter'],
    ['\x7f1axkwrx', 'badCharacter'],
    ['\x801eym55h', 'badCharacter'],
    ['pzry9x0s0muk', 'noSeparator'],
    ['1pzry9x0s0muk', 'noSeparator'],
    ['x1b4n0q5v', 'badCharacter'],
    ['li1dgmt3', 'noSeparator'],
    ['de1lg7wt\xff', 'badCharacter'],
    ['A1G7SGD8', 'badChecksum'],
    ['10a06t8', 'noSeparator'],
    ['1qzzfhee', 'noSeparator'],
    ['a12UEL5L', 'mixedCase'],
    [`a1${'q'.repeat(5000)}`, 'tooLong'],
  ])('refuses %j as %s', (text, expected) => {
    expect(refusal(text)).toBe(expected)
  })

  // Checksums from BIP-173's Python reference: one data word is five bits, too many to be padding, and non-zero.
  test.each(['x1l3jt5v7', 'x1qm7ssx4'])('refuses %s, whose words are not whole bytes', (text) => {
    expect(refusal(text)).toBe('badPadding')
  })

  it.prop(
    'round-trips any bytes',
    [Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 })))],
    ([values]) => {
      const result = Result.getOrUndefined(decodeBech32(encodeBech32('sq', Uint8Array.from(values))))
      return result?.prefix === 'sq' && Array.from(result.bytes).join() === values.join()
    },
  )
})
