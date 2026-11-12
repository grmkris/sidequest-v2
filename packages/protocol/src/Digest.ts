import { Schema } from 'effect'

/** A SHA-256 digest as 64 lowercase hex characters. */
export const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)).pipe(Schema.brand('Digest'))
export type Digest = typeof Digest.Type
