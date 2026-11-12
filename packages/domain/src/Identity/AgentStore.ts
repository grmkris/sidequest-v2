import { Agent, AgentId, Grant } from '@sidequest/protocol'
import { Context, Effect, Layer, Match, Option, Schema } from 'effect'
import { RowVersion, versionedRows } from '../VersionedRows.ts'

/** An agent as its operator's list shows it. `version` is the agent stream's sequence number it reflects. */
export const AgentRow = Schema.Struct({
  id: AgentId,
  operator: Agent.fields.operator,
  name: Agent.fields.name,
  grant: Schema.NullOr(Grant),
  revoked: Schema.Boolean,
  version: RowVersion,
})
export type AgentRow = typeof AgentRow.Type

/** One change to an agent row, at the agent's version. */
export const AgentChange = Schema.Union([
  Schema.TaggedStruct('Registered', {
    id: AgentId,
    operator: Agent.fields.operator,
    name: Agent.fields.name,
    version: RowVersion,
  }),
  Schema.TaggedStruct('Granted', { id: AgentId, grant: Grant, version: RowVersion }),
  Schema.TaggedStruct('Revoked', { id: AgentId, version: RowVersion }),
])
export type AgentChange = typeof AgentChange.Type

/**
 * The port the `Agents` projection writes rows through. `apply` must ignore a change whose version is not newer than
 * the row's, so redelivered changes are harmless. The server implements it with D1.
 */
export class AgentStore extends Context.Service<
  AgentStore,
  {
    readonly apply: (changes: ReadonlyArray<AgentChange>) => Effect.Effect<void>
    readonly get: (id: AgentId) => Effect.Effect<Option.Option<AgentRow>>
  }
>()('Sidequest/AgentStore') {}

/** An agent store in memory, for stories. A grant or revocation of an agent it has not seen registered shows nothing. */
export const memoryAgentStore = () => {
  const rows = versionedRows<AgentRow>()
  return AgentStore.of({
    apply: (changes) =>
      Effect.sync(() => {
        for (const change of changes)
          rows.change(change.id, change.version, (row) =>
            Match.valueTags(change, {
              Registered: ({ _tag, ...registered }) => ({ ...registered, grant: null, revoked: false }),
              Granted: ({ grant, version }) => (row === undefined ? row : { ...row, grant, version }),
              Revoked: ({ version }) => (row === undefined ? row : { ...row, revoked: true, version }),
            }),
          )
      }),
    get: (id) => Effect.sync(() => Option.fromUndefinedOr(rows.get(id))),
  })
}

export const MemoryAgentStore = Layer.sync(AgentStore, memoryAgentStore)
