import { Schema } from 'effect'

/** `bytes` bytes as exactly `2 × bytes` lowercase hex characters, the form NIP-01 uses for ids, keys and signatures. */
export const lowerHex = (bytes: number) =>
  Schema.String.check(Schema.isPattern(new RegExp(`^[0-9a-f]{${bytes * 2}}$`, 'u')))

/** Lowercase hex of the bytes. */
export const hexOf = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

/**
 * The bytes a hex string spells. Total: callers pass hex a schema has already checked, and a character outside
 * `[0-9a-fA-F]` reads as zero rather than throwing.
 */
export const bytesOf = (hex: string): Uint8Array =>
  Uint8Array.from({ length: hex.length >> 1 }, (_, index) => {
    const byte = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
    return Number.isNaN(byte) ? 0 : byte
  })
