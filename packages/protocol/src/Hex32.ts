import { Schema } from 'effect'

/** 32 bytes as 64 lowercase hex characters: an event id or an x-only public key. */
export const Hex32 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))
