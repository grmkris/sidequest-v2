import { Effect, Schema } from 'effect'
import { webCrypto } from './WebCrypto.ts'

/** A SHA-256 digest as 64 lowercase hex characters. */
export const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)).pipe(Schema.brand('Digest'))
export type Digest = typeof Digest.Type

/** `sha256(UTF-8 text)` as lowercase hex. */
export const textDigest = Effect.fn('Sidequest.Protocol.textDigest')(
  function* (text: string) {
    const hash = yield* webCrypto.digest('SHA-256', new TextEncoder().encode(text))
    return yield* Digest.makeEffect(Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join(''))
  },
  // Web Crypto always computes SHA-256 and its 32 bytes are always 64 hex characters, so any failure is a broken
  // invariant.
  Effect.orDie,
)
