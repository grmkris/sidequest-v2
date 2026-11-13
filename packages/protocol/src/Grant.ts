import { Schema } from 'effect'

/** What an agent may do for its operator under a grant event. There is no `pay` scope: agents never pay. */
export const GrantScope = Schema.Literals(['discuss', 'propose', 'accept', 'deliver'])
export type GrantScope = typeof GrantScope.Type
