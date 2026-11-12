import { Schema } from 'effect'
import { GrantScopes } from './Grant.ts'
import { AccountId, AgentId } from './Id.ts'

/** Who is acting on a request: an account, optionally through one of its agents with that agent's scopes. */
export const Actor = Schema.Struct({
  account: AccountId,
  agent: Schema.optionalKey(Schema.Struct({ id: AgentId, scopes: GrantScopes })),
})
export type Actor = typeof Actor.Type
