/** Hashing and tokens with WebCrypto only, so the Workers, the scripts and the tests share one implementation. */

const hex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')

export const sha256Hex = async (data: Uint8Array | string): Promise<string> => {
  const source = typeof data === 'string' ? new TextEncoder().encode(data) : data
  // A copy over a plain ArrayBuffer: WebCrypto does not take a view over a shared buffer.
  const bytes = new Uint8Array(source.byteLength)
  bytes.set(source)
  return hex(await crypto.subtle.digest('SHA-256', bytes))
}

/** A 128-bit random token, base64url without padding (22 characters). */
export const randomToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return btoa(String.fromCodePoint(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

export const isToken = (text: string): boolean => /^[A-Za-z0-9_-]{22}$/u.test(text)

/** Tokens are stored and compared only as this hash. */
export const tokenHash = (token: string): Promise<string> => sha256Hex(`crit-token:${token}`)

/** A new row's id: a random UUID. Here, so Effect code names one source of randomness and tests can find it. */
export const randomId = (): string => crypto.randomUUID()

/** A share link's public name: 16 hex characters. */
export const randomLinkId = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, '0')).join('')
