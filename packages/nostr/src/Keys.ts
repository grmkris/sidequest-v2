import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { Schema } from 'effect'
import { bytesOf, hexOf, lowerHex } from './Hex.ts'

/** A person or agent on Nostr: a BIP-340 x-only public key as 64 lowercase hex characters (NIP-01 `pubkey`). */
export const PublicKey = lowerHex(32).pipe(Schema.brand('PublicKey'))
export type PublicKey = typeof PublicKey.Type

/** A secp256k1 secret key as 64 lowercase hex characters: a scalar in `[1, n - 1]`. */
export const SecretKey = lowerHex(32)
  .check(Schema.makeFilter((hex: string) => secp256k1.utils.isValidPrivateKey(hex), { expected: 'secp256k1Scalar' }))
  .pipe(Schema.brand('SecretKey'))
export type SecretKey = typeof SecretKey.Type

/** The x-only public key of a secret key (BIP-340 `PubKey(sk)`). */
export const publicKeyOf = (secret: SecretKey): PublicKey =>
  // A valid scalar always has a point, and its x coordinate is always 32 bytes.
  PublicKey.make(hexOf(schnorr.getPublicKey(bytesOf(secret))))
