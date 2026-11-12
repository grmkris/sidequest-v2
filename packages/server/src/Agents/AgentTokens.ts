import {
  AgentAccessToken,
  AgentId,
  AgentToken,
  AgentTokenId,
  type BadCursor,
  type Cursor,
  generateId,
  type IssuedAgentToken,
  textDigest,
  type Unavailable,
  type UnixSeconds,
} from '@sidequest/protocol'
import { Context, Effect, Layer, Option, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'
import { cursors, nextCursor, type PageRequest, pageOf, rowsFor } from '../Reads/Pages.ts'
import { randomHex } from '../SignIn/Sessions.ts'
import { stored } from '../SignIn/Stored.ts'

/** The live token a bearer credential names: which token, for which agent, until when. */
export const LiveToken = Schema.Struct({ id: AgentTokenId, agent: AgentId, expiresAt: Schema.Int })
export type LiveToken = typeof LiveToken.Type

/** A page's cursor: the id of the last token on it. */
const after = cursors(Schema.Struct({ id: AgentTokenId }))

const isAccessToken = Schema.is(AgentAccessToken)

/**
 * Agents' access tokens in D1. The agent holds a random token; the table holds only its SHA-256, the agent it is for,
 * when it was issued, when it ends and when it was revoked. A token that ended, was revoked, never existed or is not
 * shaped like one finds nothing. D1 not answering is `Unavailable`.
 */
export class AgentTokens extends Context.Service<
  AgentTokens,
  {
    readonly issue: (
      agent: AgentId,
      lifetimeSeconds: number,
      now: UnixSeconds,
    ) => Effect.Effect<IssuedAgentToken, Unavailable>
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
          SELECT id, agent, expires_at AS expiresAt FROM agent_tokens
          WHERE token_hash = ${tokenHash} AND revoked_at IS NULL AND expires_at > ${now}`,
      })
      const listed = SqlSchema.findAll({
        Request: Schema.Struct({ agent: AgentId, after: Schema.NullOr(AgentTokenId), rows: Schema.Int }),
        Result: AgentToken,
        execute: ({ agent, after: last, rows }) => sql`
          SELECT id, agent, issued_at AS issuedAt, expires_at AS expiresAt, revoked_at AS revokedAt FROM agent_tokens
          WHERE agent = ${agent} AND (${last} IS NULL OR id > ${last})
          ORDER BY id LIMIT ${rows}`,
      })
      const owned = SqlSchema.findOneOption({
        Request: Schema.Struct({ agent: AgentId, id: AgentTokenId }),
        Result: Schema.Struct({ id: AgentTokenId }),
        execute: ({ agent, id }) => sql`SELECT id FROM agent_tokens WHERE id = ${id} AND agent = ${agent}`,
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
            UPDATE agent_tokens SET revoked_at = ${now} WHERE id = ${id} AND agent = ${agent} AND revoked_at IS NULL`)
          return true
        }),
      })
    }),
  )
}
