import { Crypto, Effect, Schema } from 'effect'

/**
 * 32 fresh random bytes: BIP-340 auxiliary randomness, a NIP-44 nonce, a one-time NIP-59 key. Every function that
 * needs randomness takes it as an argument, so the same inputs always give the same event; `freshEntropy` draws it
 * from the `Crypto` service the host provides.
 */
export const Entropy = Schema.Uint8Array.check(Schema.isBetweenLength(32, 32)).pipe(Schema.brand('Entropy'))
export type Entropy = typeof Entropy.Type

/** 32 bytes from the host's `Crypto` service. */
export const freshEntropy: Effect.Effect<Entropy, never, Crypto.Crypto> = Crypto.Crypto.use((crypto) =>
  crypto.randomBytes(32).pipe(
    Effect.flatMap((bytes) => Entropy.makeEffect(bytes)),
    // Crypto fails only for a negative or fractional size, and the result is always 32 bytes.
    Effect.orDie,
  ),
)
