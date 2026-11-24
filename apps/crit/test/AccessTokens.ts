/**
 * A stand-in for Cloudflare Access in tests: one RSA key pair, its public half as the JWKS the Worker is handed
 * (`ACCESS_JWKS`), and tokens signed with the private half, shaped as Access's are. WebCrypto only, so the unit tests
 * and the workerd journey share it.
 */
const encoder = new TextEncoder()

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCodePoint(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')

const part = (value: unknown): string => base64url(encoder.encode(JSON.stringify(value)))

interface Claims {
  readonly email: string
  readonly aud: string
  readonly iss: string
  /** Seconds since the epoch. */
  readonly exp: number
}

export interface Signer {
  /** The public key as a JWKS, for the Worker's `ACCESS_JWKS`. */
  readonly jwks: string
  readonly sign: (claims: Claims) => Promise<string>
}

export const makeSigner = async (kid = 'test-key'): Promise<Signer> => {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const jwks = JSON.stringify({ keys: [{ kid, kty: 'RSA', n: jwk.n ?? '', e: jwk.e ?? '' }] })
  const sign = async (claims: Claims): Promise<string> => {
    const head = part({ alg: 'RS256', kid, typ: 'JWT' })
    const body = part({ aud: [claims.aud], iss: claims.iss, exp: claims.exp, email: claims.email, type: 'app' })
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, encoder.encode(`${head}.${body}`))
    return `${head}.${body}.${base64url(new Uint8Array(signature))}`
  }
  return { jwks, sign }
}
