import {
  AgentAccessToken,
  AgentId,
  AgentToken,
  AgentTokenId,
  type BadCursor,
  type ConnectionId,
  type Cursor,
  generateId,
  type IssuedAgentToken,
  textDigest,
  type Unavailable,
  type UnixSeconds,
} from '@sidequest/protocol'
import { Context, Effect, Layer, Option, Redacted, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'
import { cursors, nextCursor, type PageRequest, pageOf, rowsFor } from '../Reads/Pages.ts'
import { randomHex } from '../SignIn/Sessions.ts'
import { stored } from '../SignIn/Stored.ts'

/**
 * The live token a bearer credential names: which token, for which agent, until when, and, for a token issued over
 * OAuth, the resource its connection is for (`null` for a token its operator issued by hand).
 */
export const LiveToken = Schema.Struct({
  id: AgentTokenId,
  agent: AgentId,
  expiresAt: Schema.Int,
  resource: Schema.NullOr(Schema.String),
})
export type LiveToken = typeof LiveToken.Type

/** A page's cursor: the id of the last token on it. */
const after = cursors(Schema.Struct({ id: AgentTokenId }))

const isAccessToken = Schema.is(AgentAccessToken)

/**
 * Agents' access tokens in D1. The agent holds a random token; the table holds only its SHA-256, the agent it is for,
 * when it was issued, when it ends and when it was revoked. A token that ended, was revoked, never existed or is not
 * shaped like one finds nothing, and so does one issued over OAuth whose connection was revoked. The tokens an operator
 * lists and revokes by hand are the ones they issued by hand; OAuth's are managed as connections. D1 not answering is
 * `Unavailable`.
 */
export class AgentTokens extends Context.Service<
  AgentTokens,
  {
    readonly issue: (
      agent: AgentId,
      lifetimeSeconds: number,
      now: UnixSeconds,
    ) => Effect.Effect<IssuedAgentToken, Unavailable>
    /**
     * A token for the agent of `connection`, issued only while the connection stands (one statement, so a connection
     * revoked a moment before gets none). `None` when it no longer stands.
     */
    readonly issueForConnection: (
      connection: ConnectionId,
      lifetimeSeconds: number,
      now: UnixSeconds,
    ) => Effect.Effect<
      Option.Option<{ readonly token: Redacted.Redacted; readonly expiresAt: UnixSeconds }>,
      Unavailable
    >
    readonly find: (token: string, now: UnixSeconds) => Effect.Effect<Option.Option<LiveToken>, Unavailable>
    readonly page: (
      agent: AgentId,
      request: PageRequest,
    ) => Effect.Effect<
      { readonly items: ReadonlyArray<AgentToken>; readonly next: Cursor | null },
      BadCursor | Unavailable
    >
    /** Revokes the agent's token `id`, if it has one by that id; answers whether it does. Revoking twice is a no-op. */
    readonly revoke: (agent: AgentId, id: AgentTokenId, now: UnixSeconds) => Effect.Effect<boolean, Unavailable>
  }
>()('Sidequest/AgentTokens') {
  static readonly layer = Layer.effect(
    AgentTokens,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const live = SqlSchema.findOneOption({
        Request: Schema.Struct({ tokenHash: Schema.String, now: Schema.Int }),
        Result: LiveToken,
        execute: ({ tokenHash, now }) => sql`
          SELECT t.id, t.agent, t.expires_at AS expiresAt, c.resource FROM agent_tokens t
          LEFT JOIN oauth_connections c ON c.id = t.connection
          WHERE t.token_hash = ${tokenHash} AND t.revoked_at IS NULL AND t.expires_at > ${now}
            AND (t.connection IS NULL OR (c.id IS NOT NULL AND c.revoked_at IS NULL))`,
      })
      const listed = SqlSchema.findAll({
        Request: Schema.Struct({ agent: AgentId, after: Schema.NullOr(AgentTokenId), rows: Schema.Int }),
        Result: AgentToken,
        execute: ({ agent, after: last, rows }) => sql`
          SELECT id, agent, issued_at AS issuedAt, expires_at AS expiresAt, revoked_at AS revokedAt FROM agent_tokens
          WHERE agent = ${agent} AND connection IS NULL AND (${last} IS NULL OR id > ${last})
          ORDER BY id LIMIT ${rows}`,
      })
      const owned = SqlSchema.findOneOption({
        Request: Schema.Struct({ agent: AgentId, id: AgentTokenId }),
        Result: Schema.Struct({ id: AgentTokenId }),
        execute: ({ agent, id }) =>
          sql`SELECT id FROM agent_tokens WHERE id = ${id} AND agent = ${agent} AND connection IS NULL`,
      })
      return AgentTokens.of({
        issue: Effect.fn('Sidequest.AgentTokens.issue')(function* (agent, lifetimeSeconds, now) {
          const id = yield* generateId('AgentTokenId')
          const token = AgentAccessToken.make(`sqa_${yield* randomHex(32)}`)
          const expiresAt = now + lifetimeSeconds
          yield* stored(sql`
            INSERT INTO agent_tokens (id, token_hash, agent, issued_at, expires_at)
            VALUES (${id}, ${yield* textDigest(token)}, ${agent}, ${now}, ${expiresAt})`)
          return { id, agent, issuedAt: now, expiresAt, revokedAt: null, token }
        }),
        issueForConnection: Effect.fn('Sidequest.AgentTokens.issueForConnection')(
          function* (connection, lifetimeSeconds, now) {
            const id = yield* generateId('AgentTokenId')
            const token = AgentAccessToken.make(`sqa_${yield* randomHex(32)}`)
            const expiresAt = now + lifetimeSeconds
            const issued = yield* stored(sql`
              INSERT INTO agent_tokens (id, token_hash, agent, issued_at, expires_at, connection)
              SELECT ${id}, ${yield* textDigest(token)}, agent, ${now}, ${expiresAt}, id FROM oauth_connections
              WHERE id = ${connection} AND revoked_at IS NULL
              RETURNING id`)
            return issued.length === 1 ? Option.some({ token: Redacted.make<string>(token), expiresAt }) : Option.none()
          },
        ),
        find: Effect.fn('Sidequest.AgentTokens.find')(function* (token, now) {
          if (!isAccessToken(token)) return yield* Effect.succeedNone
          return yield* stored(live({ tokenHash: yield* textDigest(token), now }))
        }),
        page: Effect.fn('Sidequest.AgentTokens.page')(function* (agent, { limit, cursor }) {
          const start = yield* after.decode(cursor)
          const rows = yield* stored(listed({ agent, after: start?.id ?? null, rows: rowsFor(limit) }))
          const { items, last } = pageOf(rows, limit)
          return { items, next: yield* nextCursor(after.encode, last, ({ id }) => ({ id })) }
        }),
        revoke: Effect.fn('Sidequest.AgentTokens.revoke')(function* (agent, id, now) {
          const found = yield* stored(owned({ agent, id }))
          if (Option.isNone(found)) return false
          yield* stored(sql`
            UPDATE agent_tokens SET revoked_at = ${now}
            WHERE id = ${id} AND agent = ${agent} AND connection IS NULL AND revoked_at IS NULL`)
          return true
        }),
      })
    }),
  )
}
