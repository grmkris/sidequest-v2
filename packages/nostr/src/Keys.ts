import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { Crypto, Effect, Schema } from 'effect'
import { bytesOf, hexOf, lowerHex } from './Hex.ts'

/** A person or agent on Nostr: a BIP-340 x-only public key as 64 lowercase hex characters (NIP-01 `pubkey`). */
export const PublicKey = lowerHex(32).pipe(Schema.brand('PublicKey'))
export type PublicKey = typeof PublicKey.Type

/** A secp256k1 secret key as 64 lowercase hex characters: a scalar in `[1, n - 1]`. */
export const SecretKey = lowerHex(32)
  .check(Schema.makeFilter((hex: string) => secp256k1.utils.isValidPrivateKey(hex), { expected: 'secp256k1Scalar' }))
  .pipe(Schema.brand('SecretKey'))
export type SecretKey = typeof SecretKey.Type

/**
 * A fresh secret key: 32 bytes from the host's `Crypto` service, drawn again in the vanishing case (about 2^-128)
 * that they are not a valid scalar.
 */
export const freshSecretKey: Effect.Effect<SecretKey, never, Crypto.Crypto> = Crypto.Crypto.use((crypto) =>
  crypto.randomBytes(32).pipe(
    // Crypto fails only for a negative or fractional size.
    Effect.orDie,
    Effect.flatMap((bytes) => Schema.decodeUnknownEffect(SecretKey)(hexOf(bytes))),
    Effect.eventually,
  ),
)

/** The x-only public key of a secret key (BIP-340 `PubKey(sk)`). */
export const publicKeyOf = (secret: SecretKey): PublicKey =>
  // A valid scalar always has a point, and its x coordinate is always 32 bytes.
  PublicKey.make(hexOf(schnorr.getPublicKey(bytesOf(secret))))
