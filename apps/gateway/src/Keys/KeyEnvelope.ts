import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { type PublicKey, SecretKey } from '@sidequest/nostr'
import { Crypto, Effect, Redacted, Result, Schema } from 'effect'
import { Hex } from 'effect/encoding'

// Envelope encryption of agents' keys at rest. Each agent's secp256k1 key is sealed with its own random data key, and
// the data key is sealed with the gateway's secret (a Worker secret of the stage, never in D1). Both seals are
// XChaCha20-Poly1305 with a random 24-byte nonce, and both bind the agent's public key as associated data, so a sealed
// key copied to another agent's row does not open. Without the secret, D1's rows open nothing; with it, a key opens
// only in the memory of the request that signs with it.

/** The envelope's format; a row records the version that sealed it. */
export const envelopeVersion = 1

/** The gateway's secret: 32 random bytes as 64 lowercase hex characters, held as a Worker secret. */
export const GatewaySecret = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)).pipe(
  Schema.brand('GatewaySecret'),
)
export type GatewaySecret = typeof GatewaySecret.Type

/** An agent's key as stored: its data key sealed by the gateway's secret, and the key sealed by its data key. */
export interface SealedKey {
  readonly version: number
  readonly dataKeySealed: string
  readonly keySealed: string
}

/** The sealed key does not open: the wrong secret, another agent's row, an unknown version, or altered bytes. */
export class KeyUnsealable extends Schema.TaggedError<KeyUnsealable>()('KeyUnsealable', {}) {}

const nonceBytes = 24
const encoder = new TextEncoder()
const dataKeyContext = (agent: PublicKey) => encoder.encode(`sidequest-gateway/v${envelopeVersion}/data-key/${agent}`)
const keyContext = (agent: PublicKey) => encoder.encode(`sidequest-gateway/v${envelopeVersion}/agent-key/${agent}`)

/** `nonce || ciphertext` of `plaintext` under `key`, bound to `context`. */
const sealWith = (key: Uint8Array, nonce: Uint8Array, context: Uint8Array, plaintext: Uint8Array) => {
  const sealed = xchacha20poly1305(key, nonce, context).encrypt(plaintext)
  const joined = new Uint8Array(nonce.length + sealed.length)
  joined.set(nonce)
  joined.set(sealed, nonce.length)
  return Hex.encode(joined)
}

/** The plaintext of a `nonce || ciphertext`, if it opens under `key` with `context`; Poly1305 refuses any change. */
const openWith = (key: Uint8Array, context: Uint8Array, hex: string): Result.Result<Uint8Array, KeyUnsealable> =>
  Result.flatMap(
    Result.mapError(Hex.decode(hex), () => new KeyUnsealable()),
    (joined) =>
      joined.length <= nonceBytes
        ? Result.fail(new KeyUnsealable())
        : Result.try({
            try: () =>
              xchacha20poly1305(key, joined.subarray(0, nonceBytes), context).decrypt(joined.subarray(nonceBytes)),
            catch: () => new KeyUnsealable(),
          }),
  )

/** The bytes of hex a schema has already checked (a `GatewaySecret`, a `SecretKey`), so decoding cannot fail. */
const checkedBytes = (hex: string) => Result.getOrElse(Hex.decode(hex), () => new Uint8Array(0))

const secretBytes = (secret: Redacted.Redacted<GatewaySecret>) => checkedBytes(Redacted.value(secret))

/** The randomness one seal draws: a data key and two nonces. Passed in, so the same inputs seal the same way. */
export interface SealEntropy {
  readonly dataKey: Uint8Array
  readonly dataKeyNonce: Uint8Array
  readonly keyNonce: Uint8Array
}

/** Seals `key`, the agent `agent`'s secret key, under the gateway's secret with the given randomness. */
export const sealKey = (
  secret: Redacted.Redacted<GatewaySecret>,
  agent: PublicKey,
  key: SecretKey,
  entropy: SealEntropy,
): SealedKey => ({
  version: envelopeVersion,
  dataKeySealed: sealWith(secretBytes(secret), entropy.dataKeyNonce, dataKeyContext(agent), entropy.dataKey),
  keySealed: sealWith(entropy.dataKey, entropy.keyNonce, keyContext(agent), checkedBytes(key)),
})

/** Fresh randomness for one seal, from the host's `Crypto` service. */
export const freshSealEntropy = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto
  // Crypto fails only for a negative or fractional size.
  const draw = (size: number) => Effect.orDie(crypto.randomBytes(size))
  return { dataKey: yield* draw(32), dataKeyNonce: yield* draw(nonceBytes), keyNonce: yield* draw(nonceBytes) }
})

/** Opens an agent's sealed key: its data key with the gateway's secret, then the key with the data key. */
export const openKey = (
  secret: Redacted.Redacted<GatewaySecret>,
  agent: PublicKey,
  sealed: SealedKey,
): Result.Result<SecretKey, KeyUnsealable> => {
  if (sealed.version !== envelopeVersion) return Result.fail(new KeyUnsealable())
  return openWith(secretBytes(secret), dataKeyContext(agent), sealed.dataKeySealed).pipe(
    Result.flatMap((dataKey) => openWith(dataKey, keyContext(agent), sealed.keySealed)),
    Result.flatMap((bytes) =>
      Result.mapError(Schema.decodeUnknownResult(SecretKey)(Hex.encode(bytes)), () => new KeyUnsealable()),
    ),
  )
}
