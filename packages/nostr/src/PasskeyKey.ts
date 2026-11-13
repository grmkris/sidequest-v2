import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { Array, Option, Schema } from 'effect'
import { hexOf } from './Hex.ts'
import { SecretKey } from './Keys.ts'

// A Nostr key derived from a passkey with WebAuthn's PRF extension (ADR-0003 decision 4, ADR-0005). The passkey's
// authenticator evaluates its PRF at one fixed input, and the 32 bytes it answers become the key, so the key is never
// stored: any device holding the passkey derives it again. Version 1:
//
//   PRF input (`prf.eval.first`) = SHA-256("sidequest/nostr-key/v1")
//   candidate(counter)           = HKDF-SHA256(IKM = PRF output, salt = empty, info = "sidequest/nostr-key/v1/secp256k1/"
//                                    + counter in decimal, L = 32), counter = 0, 1, 2, …
//   key                          = the first candidate that, read big-endian, is in [1, n − 1] (n: secp256k1's order)
//
// A candidate is out of range with probability about 2^-128, so the counter is 0 for every key there will ever be; the
// rule only makes the derivation total. Changing any of this changes every derived key: a new rule is a new version.

/** The version label every input and info string of this derivation starts with. */
export const passkeyKeyVersion = 'sidequest/nostr-key/v1'

const ascii = (text: string) => new TextEncoder().encode(text)

/** The PRF input every Sidequest passkey is evaluated at: SHA-256 of {@link passkeyKeyVersion}. */
export const passkeyPrfInput = (): Uint8Array => sha256(ascii(passkeyKeyVersion))

/** How many counters are tried before the derivation gives up (it never does, short of a broken HKDF). */
export const passkeyKeyAttempts = 256

/** HKDF's info for one counter. */
export const passkeyKeyInfo = (counter: number): string => `${passkeyKeyVersion}/secp256k1/${counter}`

/** The candidate key for one counter. */
export const passkeyKeyCandidate = (prfOutput: Uint8Array, counter: number): Uint8Array =>
  hkdf(sha256, prfOutput, undefined, ascii(passkeyKeyInfo(counter)), 32)

const decodeSecretKey = Schema.decodeUnknownOption(SecretKey)

/** The first candidate that is a secp256k1 secret key, counting from 0; none after {@link passkeyKeyAttempts}. */
export const firstValidKey = (candidateAt: (counter: number) => Uint8Array): Option.Option<SecretKey> =>
  Array.findFirst(
    Array.makeBy(passkeyKeyAttempts, (counter) => counter),
    (counter) => decodeSecretKey(hexOf(candidateAt(counter))),
  )

/** The PRF output's length WebAuthn gives: 32 bytes. */
export const prfOutputLength = 32

/** The Nostr secret key a passkey's PRF output derives; none for an output that is not 32 bytes. */
export const secretKeyFromPrf = (prfOutput: Uint8Array): Option.Option<SecretKey> =>
  prfOutput.length === prfOutputLength
    ? firstValidKey((counter) => passkeyKeyCandidate(prfOutput, counter))
    : Option.none()
