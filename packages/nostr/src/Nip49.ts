import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { scryptAsync } from '@noble/hashes/scrypt.js'
import { concatBytes } from '@noble/hashes/utils.js'
import { Crypto, Effect, Option, Result, Schema } from 'effect'
import { attempt } from './Attempt.ts'
import { decodeBech32, encodeBech32 } from './Bech32.ts'
import { bytesOf, hexOf } from './Hex.ts'
import { SecretKey } from './Keys.ts'

/** Why a secret key would not be encrypted or decrypted with a password (NIP-49). */
export class Nip49Refused extends Schema.TaggedError<Nip49Refused>()('Nip49Refused', {
  reason: Schema.Literals([
    /** Not bech32, not `ncryptsec`, or not the 91 bytes of a version-2 payload. */
    'notNcryptsec',
    'unknownVersion',
    'unknownKeySecurity',
    /** A `log_n` outside `[1, maxLogN]`: scrypt would refuse it, or it would cost more memory than allowed. */
    'cost',
    /** The password does not open the ciphertext, or the ciphertext was altered: XChaCha20-Poly1305 cannot tell. */
    'wrongPassword',
    /** It decrypted, but to 32 bytes that are not a secp256k1 secret key. */
    'notASecretKey',
  ]),
}) {}

/**
 * What the encrypting client knows of how the key was handled before (NIP-49's key-security byte, which the
 * ciphertext authenticates): `insecure` (`0x00`, it was handled insecurely, e.g. pasted unencrypted), `secure`
 * (`0x01`, it was not), or `unknown` (`0x02`).
 */
export const KeySecurity = Schema.Literals(['insecure', 'secure', 'unknown'])
export type KeySecurity = typeof KeySecurity.Type

const securityBytes: Readonly<Record<KeySecurity, number>> = { insecure: 0x00, secure: 0x01, unknown: 0x02 }
const securityOfByte = (byte: number | undefined): Option.Option<KeySecurity> =>
  byte === 0x00
    ? Option.some('insecure')
    : byte === 0x01
      ? Option.some('secure')
      : byte === 0x02
        ? Option.some('unknown')
        : Option.none()

/** 16 random bytes: the scrypt salt. */
export const Nip49Salt = Schema.Uint8Array.check(Schema.isBetweenLength(16, 16)).pipe(Schema.brand('Nip49Salt'))
export type Nip49Salt = typeof Nip49Salt.Type

/** 24 random bytes: the XChaCha20-Poly1305 nonce. */
export const Nip49Nonce = Schema.Uint8Array.check(Schema.isBetweenLength(24, 24)).pipe(Schema.brand('Nip49Nonce'))
export type Nip49Nonce = typeof Nip49Nonce.Type

/**
 * The largest `log_n` read by default: 2^20 rounds of scrypt with `r = 8` take 1 GiB, noble's own ceiling. An
 * `ncryptsec` asking for more is refused before any work, so a pasted string cannot make the browser allocate more.
 */
export const maxLogN = 20

const version = 0x02
const payloadLength = 91
const prefix = 'ncryptsec'

const refuse = (reason: Nip49Refused['reason']) => Effect.fail(new Nip49Refused({ reason }))

const validLogN = (logN: number, ceiling: number) => Number.isInteger(logN) && logN >= 1 && logN <= ceiling

/** NIP-49's key: scrypt over the NFKC-normalized password, `N = 2^log_n`, `r = 8`, `p = 1`, 32 bytes. */
const symmetricKey = (password: string, salt: Uint8Array, logN: number) =>
  Effect.tryPromise({
    // `asyncTick` yields to the event loop every few milliseconds, so a browser stays responsive while it runs.
    try: () =>
      scryptAsync(new TextEncoder().encode(password.normalize('NFKC')), salt, { N: 2 ** logN, r: 8, p: 1, dkLen: 32 }),
    catch: () => new Nip49Refused({ reason: 'cost' }),
  })

/**
 * Encrypts a secret key with a password as `ncryptsec1…` (NIP-49): version 2, `log_n`, the salt, the nonce, the
 * key-security byte and the 48-byte XChaCha20-Poly1305 ciphertext of the 32-byte key, authenticated with that byte.
 * The salt and nonce are arguments, so the same inputs always give the same string; `freshNip49` draws them.
 */
export const encryptNip49 = Effect.fnUntraced(function* (
  secret: SecretKey,
  password: string,
  options: {
    readonly logN: number
    readonly keySecurity: KeySecurity
    readonly salt: Nip49Salt
    readonly nonce: Nip49Nonce
  },
): Effect.fn.Return<string, Nip49Refused> {
  if (!validLogN(options.logN, maxLogN)) return yield* refuse('cost')
  const key = yield* symmetricKey(password, options.salt, options.logN)
  const security = Uint8Array.of(securityBytes[options.keySecurity])
  const ciphertext = xchacha20poly1305(key, options.nonce, security).encrypt(bytesOf(secret))
  return encodeBech32(
    prefix,
    concatBytes(Uint8Array.of(version, options.logN), options.salt, options.nonce, security, ciphertext),
  )
})

/** Encrypts with a fresh salt and nonce from the host's `Crypto` service. */
export const freshNip49 = Effect.fnUntraced(function* (
  secret: SecretKey,
  password: string,
  options: { readonly logN: number; readonly keySecurity: KeySecurity },
) {
  const crypto = yield* Crypto.Crypto
  // Crypto fails only for a negative or fractional size, and the lengths are exact.
  const salt = Nip49Salt.make(yield* Effect.orDie(crypto.randomBytes(16)))
  const nonce = Nip49Nonce.make(yield* Effect.orDie(crypto.randomBytes(24)))
  return yield* encryptNip49(secret, password, { ...options, salt, nonce })
})

/** A decrypted `ncryptsec`: the secret key, and what its encryption said of the key and its cost. */
export interface Nip49Opened {
  readonly secret: SecretKey
  readonly logN: number
  readonly keySecurity: KeySecurity
}

/**
 * Decrypts an `ncryptsec1…` with its password. Refuses, before running scrypt, anything that is not a version-2
 * payload or asks for a `log_n` above `ceiling` (default {@link maxLogN}).
 */
export const decryptNip49 = Effect.fnUntraced(function* (
  ncryptsec: string,
  password: string,
  ceiling: number = maxLogN,
): Effect.fn.Return<Nip49Opened, Nip49Refused> {
  const decoded = Result.getOrUndefined(decodeBech32(ncryptsec.trim()))
  if (decoded === undefined || decoded.prefix !== prefix || decoded.bytes.length !== payloadLength) {
    return yield* refuse('notNcryptsec')
  }
  const bytes = decoded.bytes
  if (bytes[0] !== version) return yield* refuse('unknownVersion')
  const logN = bytes[1] ?? 0
  if (!validLogN(logN, ceiling)) return yield* refuse('cost')
  const keySecurity = securityOfByte(bytes[42])
  if (Option.isNone(keySecurity)) return yield* refuse('unknownKeySecurity')
  const key = yield* symmetricKey(password, bytes.subarray(2, 18), logN)
  const plaintext = attempt(() =>
    xchacha20poly1305(key, bytes.subarray(18, 42), bytes.subarray(42, 43)).decrypt(bytes.subarray(43)),
  )
  if (Option.isNone(plaintext)) return yield* refuse('wrongPassword')
  const secret = Schema.decodeUnknownOption(SecretKey)(hexOf(plaintext.value))
  if (Option.isNone(secret)) return yield* refuse('notASecretKey')
  return { secret: secret.value, logN, keySecurity: keySecurity.value }
})
