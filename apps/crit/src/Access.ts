/**
 * Who Cloudflare Access admitted: the email in the `Cf-Access-Jwt-Assertion` token Access adds to every request it
 * lets through. The Worker checks it itself on every private address (RS256 signature against the organization's
 * public keys, this application's audience, the organization as issuer, an unexpired time), so a private page has two
 * guards: Access in front, and this. A request that reached the Worker around Access (a workers.dev or preview
 * address, a bypass set too wide, a deleted application) carries no valid token and gets nothing.
 */
import { Option, Schema } from 'effect'
import type { Env } from './Env.ts'

/** The bindings the check reads. */
type Guard = Pick<Env, 'ACCESS_AUD' | 'ACCESS_TEAM' | 'ACCESS_JWKS'>

const Jwks = Schema.Struct({
  keys: Schema.Array(Schema.Struct({ kid: Schema.String, kty: Schema.String, n: Schema.String, e: Schema.String })),
})
const Header = Schema.Struct({ kid: Schema.String, alg: Schema.Literal('RS256') })
const Claims = Schema.Struct({
  aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  iss: Schema.String,
  exp: Schema.Number,
  email: Schema.String,
})

const decodeJwks = Schema.decodeUnknownOption(Jwks)
const decodeJwksText = Schema.decodeUnknownOption(Schema.fromJsonString(Jwks))
const decodeHeader = Schema.decodeUnknownOption(Schema.fromJsonString(Header))
const decodeClaims = Schema.decodeUnknownOption(Schema.fromJsonString(Claims))

const base64url = (text: string): Uint8Array<ArrayBuffer> | undefined => {
  const padded = text
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(text.length / 4) * 4, '=')
  try {
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))
  } catch {
    return undefined
  }
}
const textOf = (part: string): string => {
  const bytes = base64url(part)
  return bytes === undefined ? '' : new TextDecoder().decode(bytes)
}

const importKeys = async (jwks: typeof Jwks.Type): Promise<ReadonlyMap<string, CryptoKey>> => {
  const imported = await Promise.all(
    jwks.keys
      .filter((key) => key.kty === 'RSA')
      .map(
        async (key) =>
          [
            key.kid,
            await crypto.subtle.importKey(
              'jwk',
              { kty: 'RSA', n: key.n, e: key.e, alg: 'RS256', ext: true },
              { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
              false,
              ['verify'],
            ),
          ] as const,
      ),
  )
  return new Map(imported)
}

const loopback = (hostname: string): boolean =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname.endsWith('.localhost')

/**
 * The organization's keys, or the test's own, which count only on this machine's own address: a deployed Worker
 * never takes keys from a binding. A failed fetch is no keys: every token is then refused.
 */
const loadKeys = async (env: Guard, local: boolean): Promise<ReadonlyMap<string, CryptoKey>> => {
  const inline = local ? (env.ACCESS_JWKS ?? '') : ''
  if (inline !== '') return Option.match(decodeJwksText(inline), { onNone: () => new Map(), onSome: importKeys })
  const response = await fetch(`${env.ACCESS_TEAM ?? ''}/cdn-cgi/access/certs`).catch(() => undefined)
  if (response === undefined || !response.ok) return new Map()
  const body: unknown = await response.json().catch(() => undefined)
  return Option.match(decodeJwks(body), { onNone: () => new Map(), onSome: importKeys })
}

/**
 * Keys are read once per isolate and per key source, and again when a token names one they lack (Access rotates
 * them every few weeks).
 */
let cached: { readonly source: string; readonly keys: ReadonlyMap<string, CryptoKey> } | undefined

const keyFor = async (env: Guard, kid: string, local: boolean): Promise<CryptoKey | undefined> => {
  const source = `${env.ACCESS_TEAM ?? ''}\n${local ? (env.ACCESS_JWKS ?? '') : ''}`
  if (cached?.source !== source || !cached.keys.has(kid)) cached = { source, keys: await loadKeys(env, local) }
  return cached.keys.get(kid)
}

/** The admitted email, or none when the token is missing, forged, for another application, or expired. */
export const admittedEmail = async (
  request: Request,
  env: Guard,
  nowSeconds: number,
): Promise<Option.Option<string>> => {
  const audience = env.ACCESS_AUD ?? ''
  const issuer = (env.ACCESS_TEAM ?? '').replace(/\/+$/u, '')
  const [header, payload, signature, extra] = (request.headers.get('cf-access-jwt-assertion') ?? '').split('.')
  if (audience === '' || issuer === '') return Option.none()
  if (header === undefined || payload === undefined || signature === undefined || extra !== undefined) {
    return Option.none()
  }
  const head = decodeHeader(textOf(header))
  const claims = decodeClaims(textOf(payload))
  const signed = base64url(signature)
  if (Option.isNone(head) || Option.isNone(claims) || signed === undefined) return Option.none()
  const key = await keyFor(env, head.value.kid, loopback(new URL(request.url).hostname))
  if (key === undefined) return Option.none()
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    signed,
    new TextEncoder().encode(`${header}.${payload}`),
  )
  const { aud, iss, exp, email } = claims.value
  const audiences = typeof aud === 'string' ? [aud] : aud
  return valid && audiences.includes(audience) && iss.replace(/\/+$/u, '') === issuer && exp > nowSeconds
    ? Option.some(email.toLowerCase())
    : Option.none()
}
