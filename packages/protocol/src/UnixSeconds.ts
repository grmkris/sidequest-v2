import { Schema } from 'effect'

/** An instant as whole seconds since the Unix epoch, the unit the escrow contract uses. */
export const UnixSeconds = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))
export type UnixSeconds = typeof UnixSeconds.Type
