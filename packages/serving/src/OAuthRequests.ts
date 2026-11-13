import { ConnectRequestId, generateId, type Unavailable, type UnixSeconds } from '@sidequest/protocol'
import { Context, Effect, Layer, Option, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'
import type { KnownClient } from './ClientDocuments.ts'
import { randomHex } from './Secrets.ts'
import { stored } from './Stored.ts'

// OAuth's account-free records in D1: self-registered clients and authorization requests waiting for consent. The core
// and the agent gateway each keep them in their own database, in tables of the same shape (`oauth_clients`,
// `oauth_requests`); each keeps its connections its own way. D1 has no transactions, so every step that must happen
// once (deciding a request) is one guarded `UPDATE ... RETURNING`: of any number of concurrent or replayed attempts,
// exactly one gets the row. Secrets are stored only as SHA-256. Registration's clean-up reads `oauth_connections`
// (`client_id`), which each database also has.

/** Whether a client registered itself here or is known by its metadata document. */
export const ClientKind = Schema.Literals(['registered', 'published'])

/** How long a self-registered client that never connected is kept. */
const unusedClientSeconds = 24 * 60 * 60

const Registered = Schema.Struct({
  id: Schema.String,
  name: Schema.NullOr(Schema.String),
  redirectUris: Schema.fromJsonString(Schema.Array(Schema.String)),
})

/** Clients that registered themselves (RFC 7591): their own name and the exact redirects they named. */
export class OAuthClients extends Context.Service<
  OAuthClients,
  {
    readonly register: (
      client: { readonly name: string | null; readonly redirectUris: ReadonlyArray<string> },
      now: UnixSeconds,
    ) => Effect.Effect<string, Unavailable>
    readonly find: (id: string) => Effect.Effect<Option.Option<KnownClient>, Unavailable>
  }
>()('Sidequest/OAuthClients') {
  static readonly layer = Layer.effect(
    OAuthClients,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const registered = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: Registered,
        execute: (id) => sql`SELECT id, name, redirect_uris AS redirectUris FROM oauth_clients WHERE id = ${id}`,
      })
      return OAuthClients.of({
        register: Effect.fn('Sidequest.OAuthClients.register')(function* ({ name, redirectUris }, now) {
          const id = `client_${yield* randomHex(16)}`
          // Clients that registered over a day ago and never connected anyone are dropped, so open registration
          // cannot grow the table without bound.
          yield* stored(sql`
            DELETE FROM oauth_clients WHERE registered_at < ${now - unusedClientSeconds}
              AND NOT EXISTS (SELECT 1 FROM oauth_connections WHERE client_id = oauth_clients.id)`)
          yield* stored(sql`
            INSERT INTO oauth_clients (id, name, redirect_uris, registered_at)
            VALUES (${id}, ${name}, ${JSON.stringify(redirectUris)}, ${now})`)
          return id
        }),
        find: Effect.fn('Sidequest.OAuthClients.find')(function* (id) {
          const found = yield* stored(registered(id))
          return Option.map(found, (client): KnownClient => ({ ...client, kind: 'registered', publisher: null }))
        }),
      })
    }),
  )
}

/** An authorization request waiting for consent, as stored: what the client asked for and where the answer goes. */
export const PendingRequest = Schema.Struct({
  id: ConnectRequestId,
  clientId: Schema.String,
  clientName: Schema.NullOr(Schema.String),
  clientKind: ClientKind,
  redirectUri: Schema.String,
  state: Schema.NullOr(Schema.String),
  codeChallenge: Schema.String,
  resource: Schema.String,
  expiresAt: Schema.Int,
})
export type PendingRequest = typeof PendingRequest.Type

const requestColumns = `id, client_id AS clientId, client_name AS clientName, client_kind AS clientKind,
  redirect_uri AS redirectUri, state, code_challenge AS codeChallenge, resource, expires_at AS expiresAt`

const RequestKey = Schema.Struct({ id: ConnectRequestId, bindingHash: Schema.String, now: Schema.Int })

/**
 * Authorization requests waiting for the signed-in person's consent, in the browser that opened them (`bindingHash`,
 * the hash of a cookie set on that browser). A request is decided once.
 */
export class ConnectRequests extends Context.Service<
  ConnectRequests,
  {
    readonly open: (
      request: Omit<PendingRequest, 'id'> & { readonly bindingHash: string },
      now: UnixSeconds,
    ) => Effect.Effect<ConnectRequestId, Unavailable>
    readonly pending: (
      id: ConnectRequestId,
      bindingHash: string,
      now: UnixSeconds,
    ) => Effect.Effect<Option.Option<PendingRequest>, Unavailable>
    /** Takes the request out of waiting, once; `None` if it was decided, expired, or opened in another browser. */
    readonly decide: (
      id: ConnectRequestId,
      bindingHash: string,
      now: UnixSeconds,
    ) => Effect.Effect<Option.Option<PendingRequest>, Unavailable>
  }
>()('Sidequest/ConnectRequests') {
  static readonly layer = Layer.effect(
    ConnectRequests,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const columns = sql.literal(requestColumns)
      const pending = SqlSchema.findOneOption({
        Request: RequestKey,
        Result: PendingRequest,
        execute: ({ id, bindingHash, now }) => sql`
          SELECT ${columns} FROM oauth_requests
          WHERE id = ${id} AND binding_hash = ${bindingHash} AND decided_at IS NULL AND expires_at > ${now}`,
      })
      const decided = SqlSchema.findOneOption({
        Request: RequestKey,
        Result: PendingRequest,
        execute: ({ id, bindingHash, now }) => sql`
          UPDATE oauth_requests SET decided_at = ${now}
          WHERE id = ${id} AND binding_hash = ${bindingHash} AND decided_at IS NULL AND expires_at > ${now}
          RETURNING ${columns}`,
      })
      return ConnectRequests.of({
        open: Effect.fn('Sidequest.ConnectRequests.open')(function* (request, now) {
          const id = yield* generateId('ConnectRequestId')
          yield* stored(sql`DELETE FROM oauth_requests WHERE expires_at < ${now}`)
          yield* stored(sql`
            INSERT INTO oauth_requests (id, binding_hash, client_id, client_name, client_kind, redirect_uri, state,
              code_challenge, resource, created_at, expires_at)
            VALUES (${id}, ${request.bindingHash}, ${request.clientId}, ${request.clientName}, ${request.clientKind},
              ${request.redirectUri}, ${request.state}, ${request.codeChallenge}, ${request.resource}, ${now},
              ${request.expiresAt})`)
          return id
        }),
        pending: (id, bindingHash, now) => stored(pending({ id, bindingHash, now })),
        decide: (id, bindingHash, now) => stored(decided({ id, bindingHash, now })),
      })
    }),
  )
}
