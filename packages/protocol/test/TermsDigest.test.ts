import { it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import { describe, expect } from 'vitest'
import { Terms } from '../src/Terms.ts'
import { textDigest } from '../src/Digest.ts'
import { termsDigest } from '../src/TermsDigest.ts'
import { encodedTerms, terms } from './fixtures.ts'

const decodeTerms = Schema.decodeUnknownSync(Terms)

describe('termsDigest', () => {
  // Expected value from Python: sha256(json.dumps(terms, sort_keys=True, separators=(',', ':'),
  // ensure_ascii=False)), which equals JCS for these integer and string values.
  it.effect('hashes the canonical JSON of the terms', () =>
    Effect.gen(function* () {
      expect(yield* termsDigest(terms)).toBe('3b188db9e0e2d40340b5a1edd1df3f55ab275a1702a8833161232300b1d650e2')
    }),
  )

  it.effect('ignores the key order the terms arrived in', () =>
    Effect.gen(function* () {
      const reordered = decodeTerms(Object.fromEntries(Object.entries(encodedTerms).toReversed()))
      expect(yield* termsDigest(reordered)).toBe(yield* termsDigest(terms))
    }),
  )

  it.effect('changes when any deliverable changes, including its position', () =>
    Effect.gen(function* () {
      const original = yield* termsDigest(terms)
      const edited = decodeTerms({ ...encodedTerms, deliverables: ['SVG logo', 'Brand sheet (PDF).'] })
      const swapped = decodeTerms({ ...encodedTerms, deliverables: ['Brand sheet (PDF)', 'SVG logo'] })
      expect(yield* termsDigest(edited)).not.toBe(original)
      expect(yield* termsDigest(swapped)).not.toBe(original)
    }),
  )

  it.effect('distinguishes Unicode text by code points, not appearance', () =>
    Effect.gen(function* () {
      const composed = yield* termsDigest(decodeTerms({ ...encodedTerms, title: 'Café' }))
      const decomposed = yield* termsDigest(decodeTerms({ ...encodedTerms, title: 'Café' }))
      expect(composed).not.toBe(decomposed)
      expect(composed).toMatch(/^[0-9a-f]{64}$/)
    }),
  )
})

describe('textDigest', () => {
  // Expected values from `printf '%s' "$text" | sha256sum`.
  it.effect('is the SHA-256 of the text as UTF-8, in lowercase hex', () =>
    Effect.gen(function* () {
      expect(yield* textDigest('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
      expect(yield* textDigest('Grüße ☕')).toBe('cc32342a0436a9f2fbb226c3e66e941720eb2c903a009b0e973440182f44807c')
    }),
  )
})
