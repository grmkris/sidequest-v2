import * as Domain from '@alchemy.run/domain'
import { Effect, Match } from 'effect'
import { Agent } from './Agent.aggregate.ts'
import { AgentStore } from './AgentStore.ts'
import { AgentGranted } from './GrantAgent.command.ts'
import { AgentRegistered } from './RegisterAgent.command.ts'
import { GrantRevoked } from './RevokeGrant.command.ts'

/** A row per agent, for its operator's list: its name, its grant and whether it was revoked, through {@link AgentStore}. */
export class Agents extends Domain.Projection('Agents', {
  from: [Agent],
  key: Agent,
  on: [AgentRegistered, AgentGranted, GrantRevoked],
}) {}

export const AgentsLive = Agents.toLayer(
  Effect.gen(function* () {
    const store = yield* AgentStore
    return (batch) =>
      store.apply(
        batch.map(({ key, event, envelope: { seq: version } }) =>
          Match.valueTags(event, {
            AgentRegistered: ({ operator, name }) => ({
              _tag: 'Registered' as const,
              id: key.id,
              operator,
              name,
              version,
            }),
            AgentGranted: ({ grant }) => ({ _tag: 'Granted' as const, id: key.id, grant, version }),
            GrantRevoked: () => ({ _tag: 'Revoked' as const, id: key.id, version }),
          }),
        ),
      )
  }),
)
