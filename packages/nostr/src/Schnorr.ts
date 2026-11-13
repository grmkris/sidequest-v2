import { schnorr } from '@noble/curves/secp256k1.js'
import { Option } from 'effect'
import { attempt } from './Attempt.ts'
import type { Entropy } from './Entropy.ts'
import { bytesOf } from './Hex.ts'
import type { SecretKey } from './Keys.ts'

/**
 * A BIP-340 signature of `message` with `auxRand` as the auxiliary randomness. A valid secret key and 32 bytes of
 * auxiliary randomness always sign (BIP-340 fails only when the nonce is zero, with probability 2^-256).
 */
export const schnorrSign = (message: Uint8Array, secret: SecretKey, auxRand: Entropy): Uint8Array =>
  schnorr.sign(message, bytesOf(secret), auxRand)

/** Whether `signature` is a valid BIP-340 signature of `message` by the x-only `publicKey`. Never throws. */
export const schnorrVerify = (signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean =>
  Option.getOrElse(
    attempt(() => schnorr.verify(signature, message, publicKey)),
    () => false,
  )
