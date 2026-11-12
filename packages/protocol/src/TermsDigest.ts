import { Effect, Schema } from 'effect'
import { Digest } from './Digest.ts'
import { canonicalize } from './Jcs.ts'
import { Terms } from './Terms.ts'
import { webCrypto } from './WebCrypto.ts'

const encodeTerms = Schema.encodeEffect(Terms)

/** `sha256(JCS(encoded terms))` as lowercase hex: what an accept must name to bind one exact version. */
export const termsDigest = Effect.fn('Sidequest.Protocol.termsDigest')(
  function* (terms: Terms) {
    const encoded = yield* encodeTerms(terms)
    const canonical = yield* Effect.fromResult(canonicalize(encoded))
    const hash = yield* webCrypto.digest('SHA-256', new TextEncoder().encode(canonical))
    return yield* Digest.makeEffect(Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join(''))
  },
  // Valid terms always encode to I-JSON (Text rejects unpaired surrogates, numbers are integers)
  // and a SHA-256 is always 64 hex characters, so any failure here is a broken invariant.
  Effect.orDie,
)
