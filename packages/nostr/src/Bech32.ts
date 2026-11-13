import { Result, Schema } from 'effect'

/** Why a string is not bech32, or its words are not whole bytes. */
export class InvalidBech32 extends Schema.TaggedError<InvalidBech32>()('InvalidBech32', {
  reason: Schema.Literals(['tooLong', 'mixedCase', 'noSeparator', 'badCharacter', 'badChecksum', 'badPadding']),
}) {}

const charset = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const generator = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]

// BIP-173 limits strings to 90 characters; NIP-19 lifts that to 5000 so TLV entities fit.
const maxLength = 5000

const polymod = (values: ReadonlyArray<number>) =>
  values.reduce((check, value) => {
    const top = check >>> 25
    const next = ((check & 0x1ffffff) << 5) ^ value
    return generator.reduce((acc, word, bit) => ((top >>> bit) & 1 ? acc ^ word : acc), next)
  }, 1)

const expandPrefix = (prefix: string) => {
  const codes = Array.from(prefix, (char) => char.charCodeAt(0))
  return [...codes.map((code) => code >>> 5), 0, ...codes.map((code) => code & 31)]
}

const checksumOf = (prefix: string, words: ReadonlyArray<number>) => {
  const mod = polymod([...expandPrefix(prefix), ...words, 0, 0, 0, 0, 0, 0]) ^ 1
  return Array.from({ length: 6 }, (_, index) => (mod >>> (5 * (5 - index))) & 31)
}

/** Regroups bits: 8 → 5 pads the tail with zeros; 5 → 8 refuses a tail that is not zero padding. */
const regroup = (values: ReadonlyArray<number>, from: number, to: number, pad: boolean) => {
  let accumulator = 0
  let bits = 0
  const out: number[] = []
  for (const value of values) {
    accumulator = (accumulator << from) | value
    bits += from
    while (bits >= to) {
      bits -= to
      out.push((accumulator >>> bits) & ((1 << to) - 1))
    }
    accumulator &= (1 << bits) - 1
  }
  if (pad && bits > 0) out.push((accumulator << (to - bits)) & ((1 << to) - 1))
  if (!pad && (bits >= from || accumulator !== 0)) return undefined
  return out
}

/** The bech32 (BIP-173, not bech32m) string for `bytes` under the human-readable `prefix`. */
export const encodeBech32 = (prefix: string, bytes: Uint8Array): string => {
  const words = regroup(Array.from(bytes), 8, 5, true) ?? []
  return `${prefix}1${[...words, ...checksumOf(prefix, words)].map((word) => charset.charAt(word)).join('')}`
}

const fail = (reason: InvalidBech32['reason']) => Result.fail(new InvalidBech32({ reason }))

const wordsOf = (data: string) => {
  const words = Array.from(data, (char) => charset.indexOf(char))
  return words.includes(-1) ? undefined : words
}

/** The prefix and bytes of a bech32 string, checking its case, checksum and padding. */
export const decodeBech32 = (
  text: string,
): Result.Result<{ readonly prefix: string; readonly bytes: Uint8Array }, InvalidBech32> => {
  if (text.length > maxLength) return fail('tooLong')
  if (text !== text.toLowerCase() && text !== text.toUpperCase()) return fail('mixedCase')
  const lower = text.toLowerCase()
  const separator = lower.lastIndexOf('1')
  if (separator < 1 || separator + 7 > lower.length) return fail('noSeparator')
  const prefix = lower.slice(0, separator)
  if (!/^[\x21-\x7e]+$/u.test(prefix)) return fail('badCharacter')
  const words = wordsOf(lower.slice(separator + 1))
  if (words === undefined) return fail('badCharacter')
  if (polymod([...expandPrefix(prefix), ...words]) !== 1) return fail('badChecksum')
  const bytes = regroup(words.slice(0, -6), 5, 8, false)
  return bytes === undefined ? fail('badPadding') : Result.succeed({ prefix, bytes: Uint8Array.from(bytes) })
}
