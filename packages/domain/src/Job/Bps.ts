import { Schema } from 'effect'

/** A share in basis points: 0 is none, 10 000 is all. */
export const Bps = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 }))
