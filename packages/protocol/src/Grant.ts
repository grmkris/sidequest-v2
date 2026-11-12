import { Schema } from 'effect'
import { UnixSeconds } from './UnixSeconds.ts'

/** What an agent may do for its operator. Phase 1 has no `pay` scope: agents never pay. */
export const GrantScope = Schema.Literals(['discuss', 'propose', 'accept', 'deliver'])
export type GrantScope = typeof GrantScope.Type

export const GrantScopes = Schema.Array(GrantScope).check(Schema.isMinLength(1), Schema.isUnique())

/** The authority an operator gives one agent, until it expires or is revoked. */
export const Grant = Schema.Struct({
  scopes: GrantScopes,
  expiresAt: UnixSeconds,
})
export type Grant = typeof Grant.Type
