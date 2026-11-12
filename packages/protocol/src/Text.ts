import { Schema } from 'effect'

// With the `u` flag a surrogate pair is one code point, so this matches only unpaired surrogates,
// which RFC 8785 (I-JSON) cannot carry.
const wellFormed = /^[^\uD800-\uDFFF]*$/u

/** Trimmed, non-empty, well-formed text of at most `maxLength` UTF-16 code units. */
export const Text = (maxLength: number) =>
  Schema.String.check(
    Schema.isTrimmed(),
    Schema.isMinLength(1),
    Schema.isMaxLength(maxLength),
    Schema.isPattern(wellFormed),
  )
