import { AgentRow, AgentStore, type AgentChange } from '@sidequest/domain/Identity/AgentStore'
import { AgentId, GrantScope } from '@sidequest/protocol'
import { Effect, Layer, Match, Option, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

/** An agent row as D1 holds it: the grant as its scopes (a JSON array) and expiry, or both null; revoked as 0 or 1. */
export const StoredAgent = Schema.Struct({
  id: AgentRow.fields.id,
  operator: AgentRow.fields.operator,
  name: AgentRow.fields.name,
  scopes: Schema.NullOr(Schema.fromJsonString(Schema.Array(GrantScope))),
  expiresAt: Schema.NullOr(Schema.Int),
  revoked: Schema.Literals([0, 1]),
  version: AgentRow.fields.version,
})

/** The columns {@link StoredAgent} reads. */
export const agentColumns = 'id, operator, name, scopes, expires_at AS expiresAt, revoked, version'

/** The row a stored agent is. A grant is its scopes with its expiry; the table keeps both or neither. */
export const agentRowOf = ({ scopes, expiresAt, revoked, ...agent }: typeof StoredAgent.Type) =>
  Schema.decodeUnknownEffect(AgentRow)({
    ...agent,
    grant: scopes === null || expiresAt === null ? null : { scopes, expiresAt },
    revoked: revoked === 1,
  })

/**
 * The `agents` table behind the `Agents` projection. Each change is one statement that writes only when its version
 * is newer than the row's, so a redelivered change does nothing; a grant or revocation of an agent the table has not
 * seen registered keeps only its version. D1 failing is a defect: the projection's delivery is retried.
 */
export const D1AgentStore = Layer.effect(
  AgentStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const write = (change: AgentChange) =>
      Match.valueTags(change, {
        Registered: ({ id, operator, name, version }) => sql`
          INSERT INTO agents (id, operator, name, version) VALUES (${id}, ${operator}, ${name}, ${version})
          ON CONFLICT (id) DO UPDATE SET
            operator = excluded.operator, name = excluded.name, scopes = NULL, expires_at = NULL, revoked = 0,
            version = excluded.version
          WHERE excluded.version > agents.version`,
        Granted: ({ id, grant, version }) => sql`
          INSERT INTO agents (id, version) VALUES (${id}, ${version})
          ON CONFLICT (id) DO UPDATE SET
            scopes = CASE WHEN agents.operator IS NULL THEN NULL ELSE ${JSON.stringify(grant.scopes)} END,
            expires_at = CASE WHEN agents.operator IS NULL THEN NULL ELSE ${grant.expiresAt} END,
            version = excluded.version
          WHERE excluded.version > agents.version`,
        Revoked: ({ id, version }) => sql`
          INSERT INTO agents (id, version) VALUES (${id}, ${version})
          ON CONFLICT (id) DO UPDATE SET
            revoked = CASE WHEN agents.operator IS NULL THEN 0 ELSE 1 END, version = excluded.version
          WHERE excluded.version > agents.version`,
      })
    const find = SqlSchema.findOneOption({
      Request: AgentId,
      Result: StoredAgent,
      execute: (id) => sql`SELECT ${sql.literal(agentColumns)} FROM agents WHERE id = ${id} AND operator IS NOT NULL`,
    })
    return AgentStore.of({
      apply: Effect.fn('Sidequest.Agents.apply')(function* (changes) {
        yield* Effect.forEach(changes, write, { discard: true }).pipe(Effect.orDie)
      }),
      get: Effect.fn('Sidequest.Agents.get')(function* (id) {
        const found = yield* find(id).pipe(Effect.orDie)
        if (Option.isNone(found)) return Option.none()
        return Option.some(yield* agentRowOf(found.value).pipe(Effect.orDie))
      }),
    })
  }),
)
