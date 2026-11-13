import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'
import { Context, Effect, Layer, Option, Schema } from 'effect'
import { PublicKey } from '@sidequest/nostr'
import { ConnectionId, generateId, type Unavailable, type UnixSeconds } from '@sidequest/protocol'
import { type PendingRequest } from '@sidequest/serving/OAuthRequests'
import { stored } from '@sidequest/serving/Stored'

// The gateway's OAuth connections in its D1: an operator's consent for one client to act as one of their agents, the
// one authorization code it issued, and its tokens (`oauth_tokens`: access tokens, and refresh tokens used once each).
// Only SHA-256 hashes of codes and tokens are stored. D1 has no transactions, so each step that must happen once
// (redeeming a code, using a refresh token) is one guarded `UPDATE ... RETURNING`.

/** A connection as the token endpoint and the MCP endpoint judge it. */
export const Connection = Schema.Struct({
  id: ConnectionId,
  resource: Schema.String,
  clientId: Schema.String,
  redirectUri: Schema.String,
  codeChallenge: Schema.String,
  codeExpiresAt: Schema.Int,
  operator: PublicKey,
  agent: PublicKey,
})
export type Connection = typeof Connection.Type

/** The connection's columns, each qualified by `prefix` (`c.` in a join, nothing in `RETURNING`). */
const columnsOf = (prefix: string) =>
  [
    'id',
    'resource',
    'client_id AS clientId',
    'redirect_uri AS redirectUri',
    'code_challenge AS codeChallenge',
    'code_expires_at AS codeExpiresAt',
    'operator',
    'agent',
  ]
    .map((column) => `${prefix}${column}`)
    .join(', ')

/** A redemption: the standing connection, nothing known, or a copy of something already used. */
export type Redemption =
  | { readonly _tag: 'Found'; readonly connection: Connection }
  | { readonly _tag: 'Unknown' }
  | { readonly _tag: 'Reused' }

const unknown: Redemption = { _tag: 'Unknown' }
const reusedTag: Redemption = { _tag: 'Reused' }

/** A live access token's connection and when the token ends. */
export interface LiveAccess {
  readonly connection: Connection
  readonly expiresAt: number
}

const Hashed = Schema.Struct({ hash: Schema.String, at: Schema.Int })
const TokenKind = Schema.Literals(['access', 'refresh'])

/** The statements of {@link Connections}. */
const statementsOf = (sql: SqlClient.SqlClient) => ({
  spendCode: SqlSchema.findOneOption({
    Request: Hashed,
    Result: Connection,
    execute: ({ hash, at }) => sql`
      UPDATE oauth_connections SET code_used_at = ${at}
      WHERE code_hash = ${hash} AND code_used_at IS NULL AND revoked_at IS NULL
      RETURNING ${sql.literal(columnsOf(''))}`,
  }),
  codeOwner: SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ id: ConnectionId }),
    execute: (hash) => sql`SELECT id FROM oauth_connections WHERE code_hash = ${hash}`,
  }),
  spendRefresh: SqlSchema.findOneOption({
    Request: Hashed,
    Result: Schema.Struct({ connection: ConnectionId }),
    execute: ({ hash, at }) => sql`
      UPDATE oauth_tokens SET used_at = ${at}
      WHERE token_hash = ${hash} AND kind = 'refresh' AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ${at}
      RETURNING connection`,
  }),
  standing: SqlSchema.findOneOption({
    Request: ConnectionId,
    Result: Connection,
    execute: (id) => sql`
      SELECT ${sql.literal(columnsOf('c.'))} FROM oauth_connections AS c WHERE c.id = ${id} AND c.revoked_at IS NULL`,
  }),
  token: SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ connection: ConnectionId, kind: TokenKind, clientId: Schema.String }),
    execute: (hash) => sql`
      SELECT t.connection, t.kind, c.client_id AS clientId FROM oauth_tokens AS t
      JOIN oauth_connections AS c ON c.id = t.connection WHERE t.token_hash = ${hash}`,
  }),
  live: SqlSchema.findOneOption({
    Request: Hashed,
    Result: Schema.Struct({ ...Connection.fields, expiresAt: Schema.Int }),
    execute: ({ hash, at }) => sql`
      SELECT ${sql.literal(columnsOf('c.'))}, t.expires_at AS expiresAt FROM oauth_tokens AS t
      JOIN oauth_connections AS c ON c.id = t.connection
      WHERE t.token_hash = ${hash} AND t.kind = 'access' AND t.revoked_at IS NULL AND t.expires_at > ${at}
        AND c.revoked_at IS NULL`,
  }),
})

type Statements = ReturnType<typeof statementsOf>

/** Ends a connection, and with it every token issued from it. Ending it twice is a no-op. */
const revokeWith = (sql: SqlClient.SqlClient) =>
  Effect.fn('Sidequest.Gateway.Connections.revoke')(function* (id: ConnectionId, now: UnixSeconds) {
    yield* stored(sql`UPDATE oauth_connections SET revoked_at = ${now} WHERE id = ${id} AND revoked_at IS NULL`)
  })

/** Redeeming codes and refresh tokens once; a copy that comes back ends its connection, for whoever holds it. */
const redemptions = (statements: Statements, revoke: ReturnType<typeof revokeWith>) => {
  const reused = Effect.fnUntraced(function* (id: ConnectionId, now: UnixSeconds) {
    yield* Effect.logWarning('Sidequest.Gateway.OAuth reuse revoked a connection').pipe(
      Effect.annotateLogs({ 'sidequest.oauth.connection': id }),
    )
    yield* revoke(id, now)
    return reusedTag
  })
  return {
    redeemCode: Effect.fn('Sidequest.Gateway.Connections.redeemCode')(function* (hash: string, now: UnixSeconds) {
      const spent = yield* stored(statements.spendCode({ hash, at: now }))
      if (Option.isSome(spent)) return { _tag: 'Found', connection: spent.value } satisfies Redemption
      const known = yield* stored(statements.codeOwner(hash))
      return Option.isNone(known) ? unknown : yield* reused(known.value.id, now)
    }),
    redeemRefresh: Effect.fn('Sidequest.Gateway.Connections.redeemRefresh')(function* (hash: string, now: UnixSeconds) {
      const spent = yield* stored(statements.spendRefresh({ hash, at: now }))
      if (Option.isSome(spent)) {
        const connection = yield* stored(statements.standing(spent.value.connection))
        return Option.match(connection, {
          onNone: () => unknown,
          onSome: (found): Redemption => ({ _tag: 'Found', connection: found }),
        })
      }
      const row = yield* stored(statements.token(hash))
      if (Option.isNone(row) || row.value.kind !== 'refresh') return unknown
      return yield* reused(row.value.connection, now)
    }),
  }
}

type ConnectionsService = {
  readonly open: (
    request: PendingRequest,
    party: { readonly operator: PublicKey; readonly agent: PublicKey },
    code: { readonly hash: string; readonly expiresAt: UnixSeconds },
    now: UnixSeconds,
  ) => Effect.Effect<ConnectionId, Unavailable>
  /** The connection a code was issued for, once; a code presented again revokes its connection. */
  readonly redeemCode: (hash: string, now: UnixSeconds) => Effect.Effect<Redemption, Unavailable>
  /** The connection a refresh token is for, once; one presented again revokes its connection. */
  readonly redeemRefresh: (hash: string, now: UnixSeconds) => Effect.Effect<Redemption, Unavailable>
  /** Stores a token of `kind` for a standing connection; `false` when it no longer stands. */
  readonly store: (
    connection: ConnectionId,
    token: { readonly hash: string; readonly kind: 'access' | 'refresh'; readonly expiresAt: UnixSeconds },
    now: UnixSeconds,
  ) => Effect.Effect<boolean, Unavailable>
  /** The standing connection of a live access token, by its hash. */
  readonly access: (hash: string, now: UnixSeconds) => Effect.Effect<Option.Option<LiveAccess>, Unavailable>
  /** Ends what a token names (a refresh token its whole connection, an access token itself) for its own client. */
  readonly revokeToken: (
    hash: string,
    clientId: string | undefined,
    now: UnixSeconds,
  ) => Effect.Effect<void, Unavailable>
  readonly revoke: (connection: ConnectionId, now: UnixSeconds) => Effect.Effect<void, Unavailable>
}

export class Connections extends Context.Service<Connections, ConnectionsService>()('Sidequest/Gateway/Connections') {
  /** On D1; needs the database's `SqlClient`. */
  static readonly layer = Layer.effect(
    Connections,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const statements = statementsOf(sql)
      const revoke = revokeWith(sql)
      return Connections.of({
        ...redemptions(statements, revoke),
        revoke,
        open: Effect.fn('Sidequest.Gateway.Connections.open')(function* (request, { operator, agent }, code, now) {
          const id = yield* generateId('ConnectionId')
          yield* stored(sql`
            INSERT INTO oauth_connections (id, operator, agent, client_id, client_name, client_kind, redirect_uri,
              resource, code_hash, code_challenge, code_expires_at, created_at)
            VALUES (${id}, ${operator}, ${agent}, ${request.clientId}, ${request.clientName}, ${request.clientKind},
              ${request.redirectUri}, ${request.resource}, ${code.hash}, ${request.codeChallenge}, ${code.expiresAt},
              ${now})`)
          return id
        }),
        store: Effect.fn('Sidequest.Gateway.Connections.store')(function* (connection, token, now) {
          const inserted = yield* stored(sql`
            INSERT INTO oauth_tokens (token_hash, connection, kind, issued_at, expires_at)
            SELECT ${token.hash}, id, ${token.kind}, ${now}, ${token.expiresAt} FROM oauth_connections
            WHERE id = ${connection} AND revoked_at IS NULL
            RETURNING connection`)
          return inserted.length === 1
        }),
        access: Effect.fn('Sidequest.Gateway.Connections.access')(function* (hash, now) {
          const found = yield* stored(statements.live({ hash, at: now }))
          return Option.map(found, ({ expiresAt, ...connection }) => ({ connection, expiresAt }))
        }),
        revokeToken: Effect.fn('Sidequest.Gateway.Connections.revokeToken')(function* (hash, clientId, now) {
          const row = yield* stored(statements.token(hash))
          if (Option.isNone(row) || (clientId !== undefined && clientId !== row.value.clientId)) return
          if (row.value.kind === 'refresh') return yield* revoke(row.value.connection, now)
          yield* stored(
            sql`UPDATE oauth_tokens SET revoked_at = ${now} WHERE token_hash = ${hash} AND revoked_at IS NULL`,
          )
        }),
      })
    }),
  )
}
