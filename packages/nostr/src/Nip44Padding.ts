/** NIP-44 v2 hides a message's length in buckets: 32 bytes at least, then steps of an eighth of the next power of two. */
export const paddedLength = (length: number): number => {
  if (length <= 32) return 32
  const nextPower = 1 << (Math.floor(Math.log2(length - 1)) + 1)
  const chunk = nextPower <= 256 ? 32 : nextPower / 8
  return chunk * (Math.floor((length - 1) / chunk) + 1)
}

/** The plaintext with its big-endian u16 length in front and zeros behind, to its padded length. */
export const pad = (plaintext: Uint8Array): Uint8Array => {
  const padded = new Uint8Array(2 + paddedLength(plaintext.length))
  padded[0] = plaintext.length >> 8
  padded[1] = plaintext.length & 0xff
  padded.set(plaintext, 2)
  return padded
}

/** The plaintext inside padding, or `undefined` when the length prefix disagrees with the padding around it. */
export const unpad = (padded: Uint8Array): Uint8Array | undefined => {
  const length = ((padded[0] ?? 0) << 8) | (padded[1] ?? 0)
  const fits = length > 0 && padded.length === 2 + paddedLength(length)
  return fits ? padded.subarray(2, 2 + length) : undefined
}
