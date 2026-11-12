import { Actor as ProtocolActor, AgentId, Grant } from '@sidequest/protocol'
import { Schema } from 'effect'

/**
 * A person, or one of their agents, as middleware resolved it: the protocol `Actor`, where an agent also carries
 * when its grant ends and whether its operator revoked it, so `decide` judges the grant at the command's receive time.
 */
export const Party = Schema.Struct({
  ...ProtocolActor.fields,
  agent: Schema.optionalKey(Schema.Struct({ id: AgentId, ...Grant.fields, revoked: Schema.Boolean })),
})
export type Party = typeof Party.Type

/** Sidequest itself: a policy or the settlement saga, after the chain reader verified what it reports. */
export const System = Schema.TaggedStruct('System', { name: Schema.String })
export type System = typeof System.Type

export const Actor = Schema.Union([Party, System])
export type Actor = typeof Actor.Type

export const system = (name: string): Actor => System.make({ name })
