import { ConnectRequests, OAuthClients } from '@sidequest/serving/OAuthRequests'
import { RateLimiter } from '@sidequest/serving/RateLimiter'
import { Effect, Layer } from 'effect'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { Delegations } from './Delegations/Delegations.ts'
import { GrantGate } from './Grants/GrantGate.ts'
import { AgentKeys } from './Keys/AgentKeys.ts'
import { mcpRoutes } from './Mcp/McpRoutes.ts'
import { Connections } from './OAuth/Connections.ts'
import { consentRoutes } from './OAuth/ConsentRoutes.ts'
import { oauthRoutes } from './OAuth/OAuthRoutes.ts'
import { OperatorAuth } from './Operators/Nip98.ts'
import { operatorRoutes } from './Operators/OperatorRoutes.ts'
import { pauseRoutes } from './Operators/PauseRoutes.ts'
import { AgentRoomState } from './Rooms/AgentRoomState.ts'

/** `GET /status`: the service and its release, for readiness checks. */
const statusRoute = (release: string) =>
  Layer.effectDiscard(
    Effect.flatMap(HttpRouter.HttpRouter, (router) =>
      router.add(
        'GET',
        '/status',
        Effect.succeed(HttpServerResponse.jsonUnsafe({ service: 'sidequest-gateway', status: 'ok', release })),
      ),
    ),
  )

/** The gateway's stores and gate over its D1 and the core. */
const Services = Layer.mergeAll(
  OAuthClients.layer,
  ConnectRequests.layer,
  Connections.layer,
  OperatorAuth.layer,
  RateLimiter.layer,
  GrantGate.layer,
  Delegations.layer,
  AgentRoomState.layer,
).pipe(Layer.provideMerge(AgentKeys.layer))

/**
 * Every route of the gateway: MCP at `/mcp`, OAuth and its consent page, the operator's API and the status. Needs the
 * database's `SqlClient`, the `GatewaySettings`, the `Core`, the `RoomNetwork`, the fetcher of clients' metadata
 * documents and the asker of x402 resources' challenges.
 */
export const gatewayRoutes = (release: string) =>
  Layer.mergeAll(
    mcpRoutes(release),
    oauthRoutes,
    consentRoutes,
    operatorRoutes,
    pauseRoutes,
    statusRoute(release),
  ).pipe(Layer.provide(Services))
