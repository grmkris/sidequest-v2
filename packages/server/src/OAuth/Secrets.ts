import { textDigest, webCrypto } from '@sidequest/protocol'
import { Effect, Redacted } from 'effect'
import { Base64Url } from 'effect/encoding'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { randomHex } from '../SignIn/Sessions.ts'

/** How long an authorization request waits for the person's consent. */
export const requestSeconds = 10 * 60
/** How long an authorization code may be redeemed: one minute (OAuth 2.1 §4.1.2 asks for a short life). */
export const codeSeconds = 60
/** How long an access token lasts. A refresh gets the next one. */
export const accessSeconds = 60 * 60
/** How long a refresh token lasts unused. Each use replaces it with a new one. */
export const refreshSeconds = 30 * 24 * 60 * 60

/** An authorization code: `sqc_` and 32 random bytes in hex. */
export const codePattern = /^sqc_[0-9a-f]{64}$/u
/** A refresh token: `sqr_` and 32 random bytes in hex. */
export const refreshPattern = /^sqr_[0-9a-f]{64}$/u
/** An S256 code challenge: the unpadded base64url of a SHA-256 (RFC 7636 §4.2). */
export const challengePattern = /^[A-Za-z0-9_-]{43}$/u
/** A code verifier: 43 to 128 unreserved characters (RFC 7636 §4.1). */
export const verifierPattern = /^[A-Za-z0-9._~-]{43,128}$/u

/** A new secret with its prefix, kept out of logs until it is written into the one response that carries it. */
export const newSecret = (prefix: 'sqc_' | 'sqr_') =>
  Effect.map(randomHex(32), (hex) => Redacted.make(`${prefix}${hex}`))

/** The hash a secret is stored and looked up by. */
export const hashOf = (secret: Redacted.Redacted | string) =>
  textDigest(Redacted.isRedacted(secret) ? Redacted.value(secret) : secret)

/** The S256 challenge of a verifier: `base64url(sha256(ascii(verifier)))` (RFC 7636 §4.2). */
export const s256 = (verifier: string) =>
  webCrypto.digest('SHA-256', new TextEncoder().encode(verifier)).pipe(Effect.map(Base64Url.encode), Effect.orDie)

/**
 * Browser-based MCP clients (the Inspector) call the metadata, registration, token and revocation endpoints from their
 * own origin. They send no cookie and nothing here reads one, so any origin may read the answers.
 */
export const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version',
  'access-control-max-age': '600',
} as const

/** An answer no cache may keep: it carries a secret, or it is about one (RFC 6749 §5.1). */
const uncached = { 'cache-control': 'no-store', pragma: 'no-cache' } as const

/** A JSON answer from an endpoint any origin may call. */
export const oauthJson = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: { ...corsHeaders, ...uncached } })

/** An OAuth error (RFC 6749 §5.2). The description is fixed text, never what the client sent. */
export const oauthError = (error: string, description: string, status = 400) =>
  oauthJson({ error, error_description: description }, status)

/** A CORS preflight's answer. */
export const preflight = HttpServerResponse.empty({ status: 204, headers: corsHeaders })

/**
 * The single value of each parameter, or nothing if any is repeated: OAuth parameters must not be (RFC 6749 §3.1, §3.2).
 */
export const singleValued = (parameters: URLSearchParams): Record<string, string> | undefined => {
  const values: Record<string, string> = {}
  for (const [name, value] of parameters) {
    if (Object.hasOwn(values, name)) return undefined
    values[name] = value
  }
  return values
}
