import { Schema } from 'effect'
import { Grant } from './Grant.ts'
import { AccountId, AgentId } from './Id.ts'
import { Text } from './Text.ts'

/** An agent a person operates. It acts only within its grant, and never once revoked. */
export const Agent = Schema.Struct({
  id: AgentId,
  operator: AccountId,
  name: Text(80),
  grant: Schema.optionalKey(Grant),
  revoked: Schema.Boolean,
})
export type Agent = typeof Agent.Type
