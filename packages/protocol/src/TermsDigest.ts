import { Effect, Schema } from 'effect'
import { textDigest } from './Digest.ts'
import { canonicalize } from './Jcs.ts'
import { Terms } from './Terms.ts'

const encodeTerms = Schema.encodeEffect(Terms)

/** `sha256(JCS(encoded terms))` as lowercase hex: what an accept must name to bind one exact version. */
export const termsDigest = Effect.fn('Sidequest.Protocol.termsDigest')(
  function* (terms: Terms) {
    const encoded = yield* encodeTerms(terms)
    return yield* textDigest(yield* Effect.fromResult(canonicalize(encoded)))
  },
  // Valid terms always encode to I-JSON (Text rejects unpaired surrogates, numbers are integers), so any failure
  // here is a broken invariant.
  Effect.orDie,
)
