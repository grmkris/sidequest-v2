import { Schema } from 'effect'
import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api'
import { SignedIn } from './Guards.ts'
import { AgentId, ConnectionId, ConnectRequestId } from './Id.ts'
import { refusals } from './Refusals.ts'
import { Unavailable } from './SessionApi.ts'
import { UnixSeconds } from './UnixSeconds.ts'

/**
 * Who an MCP client says it is. A client that registered itself (`registered`, RFC 7591) chose its own name, which
 * proves nothing; a client known by its metadata document (`published`) is vouched for by the host that publishes it.
 */
export const ConnectClient = Schema.Struct({
  id: Schema.String,
  name: Schema.NullOr(Schema.String),
  kind: Schema.Literals(['registered', 'published']),
  /** The host the client's metadata document is published on; `null` for a registered client. */
  publisher: Schema.NullOr(Schema.String),
})
export type ConnectClient = typeof ConnectClient.Type

/** Where the client's access goes once the person allows it: the redirect URI's host, and whether it is this device. */
export const ConnectRedirect = Schema.Struct({ host: Schema.String, loopback: Schema.Boolean })
export type ConnectRedirect = typeof ConnectRedirect.Type

/** An MCP client's request to act as one of the person's agents, as the consent page shows it. */
export const ConnectRequest = Schema.Struct({
  id: ConnectRequestId,
  client: ConnectClient,
  redirect: ConnectRedirect,
  /** The MCP endpoint the access is for. */
  resource: Schema.String,
  expiresAt: UnixSeconds,
})
export type ConnectRequest = typeof ConnectRequest.Type

/** Where the browser goes next: back to the client, with an authorization code or the person's refusal. */
export const ConnectDecision = Schema.Struct({ redirect: Schema.String })
export type ConnectDecision = typeof ConnectDecision.Type

/** A client a person connected to one of their agents, until they revoke it. */
export const Connection = Schema.Struct({
  id: ConnectionId,
  agent: AgentId,
  client: ConnectClient,
  redirect: ConnectRedirect,
  connectedAt: UnixSeconds,
})
export type Connection = typeof Connection.Type

/**
 * The authorization request is no longer waiting: it was decided, it expired, or it was started in another browser
 * (the request is bound to the browser that opened it). The client must start again.
 */
export class ConnectRequestGone extends Schema.TaggedError<ConnectRequestGone>()(
  'ConnectRequestGone',
  {},
  { httpApiStatus: 410 },
) {}

const onRequest = { request: ConnectRequestId }

/**
 * Connecting an MCP client over OAuth, as the signed-in person: read the client's request, allow it to act as one of
 * their agents or refuse it (either answers where the browser goes next), and list and revoke what they connected.
 */
export class ConnectApi extends HttpApiGroup.make('connect')
  .add(
    HttpApiEndpoint.get('request', '/api/connect/:request', {
      params: onRequest,
      success: ConnectRequest,
      error: [ConnectRequestGone, Unavailable],
    }),
    HttpApiEndpoint.post('allow', '/api/connect/:request/allow', {
      params: onRequest,
      payload: Schema.Struct({ agent: AgentId }),
      success: ConnectDecision,
      error: [...refusals, ConnectRequestGone, Unavailable],
    }),
    HttpApiEndpoint.post('refuse', '/api/connect/:request/refuse', {
      params: onRequest,
      success: ConnectDecision,
      error: [ConnectRequestGone, Unavailable],
    }),
    HttpApiEndpoint.get('connections', '/api/connections', {
      success: Schema.Struct({ items: Schema.Array(Connection) }),
      error: Unavailable,
    }),
    HttpApiEndpoint.post('disconnect', '/api/connections/:connection/revoke', {
      params: { connection: ConnectionId },
      error: [...refusals, Unavailable],
    }),
  )
  .middleware(SignedIn) {}
