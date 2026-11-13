import { GrantScope, Text, UnixSeconds } from '@sidequest/protocol'
import { Schema } from 'effect'
import { PublicKey } from './Keys.ts'
import type { KindSpec } from './KindSpec.ts'
import { sidequestKinds } from './Kinds.ts'
import { personTag } from './RoutingTags.ts'

/**
 * An operator lets one agent key act for them (kind 8218) with these scopes from `notBefore` until `expiresAt`, or
 * until a revocation names this event. Events the agent signs under it carry `["sq-grant", <this event's id>]`.
 */
export const AgentGrantContent = Schema.Struct({
  agent: PublicKey,
  scopes: Schema.Array(GrantScope).check(Schema.isMinLength(1), Schema.isUnique()),
  notBefore: UnixSeconds,
  expiresAt: UnixSeconds,
  label: Text(120),
}).check(Schema.makeFilter((grant) => grant.notBefore < grant.expiresAt, { expected: 'notBeforeBeforeExpiry' }))
export type AgentGrantContent = typeof AgentGrantContent.Type

export const agentGrant: KindSpec<AgentGrantContent> = {
  kind: sidequestKinds.grant,
  content: AgentGrantContent,
  routing: (content) => [personTag(content.agent)],
  network: 'none',
}
