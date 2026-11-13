import { AccountId, AgentId, ConnectionId, generateId, type Unavailable, type UnixSeconds } from '@sidequest/protocol'
import { ClientKind, type PendingRequest } from '@sidequest/serving/OAuthRequests'
import { stored } from '@sidequest/serving/Stored'
import { Context, Effect, Layer, Option, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

// The core's connections in D1: one person's consent for one client to act as one of their agents, with its
// single-use authorization code and rotating refresh tokens. Self-registered clients and requests waiting for consent
// are account-free and live in `@sidequest/serving/OAuthRequests`, shared with the agent gateway. D1 has no
// transactions, so every step that must happen once is one guarded `UPDATE ... RETURNING`. Secrets are stored only
// as SHA-256.

/**
 * A connection as the token endpoint judges it: whose, for which agent and client, bound to which redirect and
 * resource, with its code's challenge and expiry.
 */
export const ConnectionRow = Schema.Struct({
  id: ConnectionId,
  account: AccountId,
  agent: AgentId,
  clientId: Schema.String,
  clientName: Schema.NullOr(Schema.String),
  clientKind: ClientKind,
  redirectUri: Schema.String,
  resource: Schema.String,
  codeChallenge: Schema.String,
  codeExpiresAt: Schema.Int,
  createdAt: Schema.Int,
})
export type ConnectionRow = typeof ConnectionRow.Type

const connectionColumns = `id, account, agent, client_id AS clientId, client_name AS clientName,
  client_kind AS clientKind, redirect_uri AS redirectUri, resource, code_challenge AS codeChallenge,
  code_expires_at AS codeExpiresAt, created_at AS createdAt`

/** What redeeming an authorization code or a refresh token found: the live connection, nothing, or a replay. */
export type Redeemed =
  | { readonly _tag: 'Redeemed'; readonly connection: ConnectionRow }
  | { readonly _tag: 'Unknown' }
  | { readonly _tag: 'Replayed'; readonly connection: ConnectionId }

const HashAt = Schema.Struct({ hash: Schema.String, now: Schema.Int })

/** The statements of {@link Connections}. */
const connectionQueries = (sql: SqlClient.SqlClient) => {
  const columns = sql.literal(connectionColumns)
  return {
    redeemCode: SqlSchema.findOneOption({
      Request: HashAt,
      Result: ConnectionRow,
      execute: ({ hash, now }) => sql`
        UPDATE oauth_connections SET code_used_at = ${now}
        WHERE code_hash = ${hash} AND code_used_at IS NULL AND revoked_at IS NULL
        RETURNING ${columns}`,
    }),
    byCode: SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Schema.Struct({ id: ConnectionId }),
      execute: (hash) => sql`SELECT id FROM oauth_connections WHERE code_hash = ${hash}`,
    }),
    useRefresh: SqlSchema.findOneOption({
      Request: HashAt,
      Result: Schema.Struct({ connection: ConnectionId }),
      execute: ({ hash, now }) => sql`
        UPDATE oauth_refresh_tokens SET used_at = ${now}
        WHERE token_hash = ${hash} AND used_at IS NULL AND expires_at > ${now}
        RETURNING connection`,
    }),
    refreshOwner: SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Schema.Struct({ connection: ConnectionId, usedAt: Schema.NullOr(Schema.Int) }),
      execute: (hash) => sql`
        SELECT connection, used_at AS usedAt FROM oauth_refresh_tokens WHERE token_hash = ${hash}`,
    }),
    accessOwner: SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Schema.Struct({ connection: ConnectionId }),
      execute: (hash) => sql`
        SELECT connection FROM agent_tokens WHERE token_hash = ${hash} AND connection IS NOT NULL`,
    }),
    standing: SqlSchema.findOneOption({
      Request: ConnectionId,
      Result: ConnectionRow,
      execute: (id) => sql`SELECT ${columns} FROM oauth_connections WHERE id = ${id} AND revoked_at IS NULL`,
    }),
    listed: SqlSchema.findAll({
      Request: AccountId,
      Result: ConnectionRow,
      execute: (account) => sql`
        SELECT ${columns} FROM oauth_connections
        WHERE account = ${account} AND revoked_at IS NULL AND code_used_at IS NOT NULL
        ORDER BY id DESC LIMIT 100`,
    }),
  }
}

type ConnectionsService = {
  readonly connect: (
    request: PendingRequest,
    party: { readonly account: AccountId; readonly agent: AgentId },
    code: { readonly hash: string; readonly expiresAt: UnixSeconds },
    now: UnixSeconds,
  ) => Effect.Effect<ConnectionId, Unavailable>
  /** The connection an authorization code was issued for, once; a code used before revokes its connection. */
  readonly redeemCode: (codeHash: string, now: UnixSeconds) => Effect.Effect<Redeemed, Unavailable>
  /** A refresh token for a connection, issued only while it stands. */
  readonly issueRefresh: (
    connection: ConnectionId,
    tokenHash: string,
    lifetimeSeconds: number,
    now: UnixSeconds,
  ) => Effect.Effect<boolean, Unavailable>
  /** The connection a refresh token is for, once; a token used before revokes its connection (reuse detection). */
  readonly redeemRefresh: (tokenHash: string, now: UnixSeconds) => Effect.Effect<Redeemed, Unavailable>
  /** The standing connection a token (access or refresh, by its hash) belongs to, and which kind it is. */
  readonly tokenOwner: (
    tokenHash: string,
  ) => Effect.Effect<
    Option.Option<{ readonly connection: ConnectionRow; readonly kind: 'access' | 'refresh' }>,
    Unavailable
  >
  readonly revokeAccess: (tokenHash: string, now: UnixSeconds) => Effect.Effect<void, Unavailable>
  /** Ends a connection and every token issued from it. Revoking twice is a no-op. */
  readonly revoke: (connection: ConnectionId, now: UnixSeconds) => Effect.Effect<void, Unavailable>
  /** The person's standing connections whose code was redeemed, newest first. */
  readonly list: (account: AccountId) => Effect.Effect<ReadonlyArray<ConnectionRow>, Unavailable>
  /** The person's own standing connection by id. */
  readonly owned: (account: AccountId, id: ConnectionId) => Effect.Effect<Option.Option<ConnectionRow>, Unavailable>
}

/** Connections: one person's consent for one client to act as one of their agents, and the family of its tokens. */
export class Connections extends Context.Service<Connections, ConnectionsService>()('Sidequest/Connections') {
  static readonly layer = Layer.effect(
    Connections,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const query = connectionQueries(sql)
      const revoke = Effect.fn('Sidequest.Connections.revoke')(function* (connection: ConnectionId, now: UnixSeconds) {
        yield* stored(
          sql`UPDATE oauth_connections SET revoked_at = ${now} WHERE id = ${connection} AND revoked_at IS NULL`,
        )
      })
      /** A used code or refresh token presented again is a copy someone else may hold: its connection ends. */
      const replayed = Effect.fn('Sidequest.Connections.replayed')(function* (
        connection: ConnectionId,
        now: UnixSeconds,
      ) {
        yield* Effect.logWarning('Sidequest.OAuth replay revoked a connection').pipe(
          Effect.annotateLogs({ 'sidequest.oauth.connection': connection }),
        )
        yield* revoke(connection, now)
        return { _tag: 'Replayed', connection } as const
      })
      return Connections.of({ ...connectionWrites(sql, query, replayed), ...connectionReads(query), revoke })
    }),
  )
}

type Queries = ReturnType<typeof connectionQueries>
type Replayed = (connection: ConnectionId, now: UnixSeconds) => Effect.Effect<Redeemed, Unavailable>

const connectionWrites = (sql: SqlClient.SqlClient, query: Queries, replayed: Replayed) => ({
  connect: Effect.fn('Sidequest.Connections.connect')(function* (
    request: PendingRequest,
    { account, agent }: { readonly account: AccountId; readonly agent: AgentId },
    code: { readonly hash: string; readonly expiresAt: UnixSeconds },
    now: UnixSeconds,
  ) {
    const id = yield* generateId('ConnectionId')
    yield* stored(sql`
      INSERT INTO oauth_connections (id, account, agent, client_id, client_name, client_kind, redirect_uri, resource,
        code_hash, code_challenge, code_expires_at, created_at)
      VALUES (${id}, ${account}, ${agent}, ${request.clientId}, ${request.clientName}, ${request.clientKind},
        ${request.redirectUri}, ${request.resource}, ${code.hash}, ${request.codeChallenge}, ${code.expiresAt}, ${now})`)
    return id
  }),
  redeemCode: Effect.fn('Sidequest.Connections.redeemCode')(function* (hash: string, now: UnixSeconds) {
    const redeemed = yield* stored(query.redeemCode({ hash, now }))
    if (Option.isSome(redeemed)) return { _tag: 'Redeemed', connection: redeemed.value } satisfies Redeemed
    const known = yield* stored(query.byCode(hash))
    if (Option.isNone(known)) return { _tag: 'Unknown' } satisfies Redeemed
    return yield* replayed(known.value.id, now)
  }),
  issueRefresh: Effect.fn('Sidequest.Connections.issueRefresh')(function* (
    connection: ConnectionId,
    tokenHash: string,
    lifetimeSeconds: number,
    now: UnixSeconds,
  ) {
    const issued = yield* stored(sql`
      INSERT INTO oauth_refresh_tokens (token_hash, connection, issued_at, expires_at)
      SELECT ${tokenHash}, id, ${now}, ${now + lifetimeSeconds} FROM oauth_connections
      WHERE id = ${connection} AND revoked_at IS NULL
      RETURNING connection`)
    return issued.length === 1
  }),
  redeemRefresh: Effect.fn('Sidequest.Connections.redeemRefresh')(function* (hash: string, now: UnixSeconds) {
    const used = yield* stored(query.useRefresh({ hash, now }))
    if (Option.isSome(used)) {
      const row = yield* stored(query.standing(used.value.connection))
      return Option.match(row, {
        onNone: (): Redeemed => ({ _tag: 'Unknown' }),
        onSome: (connection): Redeemed => ({ _tag: 'Redeemed', connection }),
      })
    }
    const owner = yield* stored(query.refreshOwner(hash))
    if (Option.isNone(owner) || owner.value.usedAt === null) return { _tag: 'Unknown' } satisfies Redeemed
    return yield* replayed(owner.value.connection, now)
  }),
  revokeAccess: Effect.fn('Sidequest.Connections.revokeAccess')(function* (hash: string, now: UnixSeconds) {
    yield* stored(sql`
      UPDATE agent_tokens SET revoked_at = ${now}
      WHERE token_hash = ${hash} AND connection IS NOT NULL AND revoked_at IS NULL`)
  }),
})

const connectionReads = (query: Queries) => ({
  tokenOwner: Effect.fn('Sidequest.Connections.tokenOwner')(function* (hash: string) {
    const refresh = yield* stored(query.refreshOwner(hash))
    const access = Option.isSome(refresh) ? Option.none() : yield* stored(query.accessOwner(hash))
    const owner = Option.orElse(
      Option.map(refresh, ({ connection }) => ({ connection, kind: 'refresh' as const })),
      () => Option.map(access, ({ connection }) => ({ connection, kind: 'access' as const })),
    )
    if (Option.isNone(owner)) return Option.none()
    const row = yield* stored(query.standing(owner.value.connection))
    return Option.map(row, (connection) => ({ connection, kind: owner.value.kind }))
  }),
  list: (account: AccountId) => stored(query.listed(account)),
  owned: Effect.fn('Sidequest.Connections.owned')(function* (account: AccountId, id: ConnectionId) {
    const row = yield* stored(query.standing(id))
    return Option.filter(row, (found) => found.account === account)
  }),
})
