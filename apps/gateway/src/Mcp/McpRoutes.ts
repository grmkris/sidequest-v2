import { hashOf } from '@sidequest/serving/Secrets'
import { nowSeconds } from '@sidequest/serving/Authorize'
import { mcpPath, protectedResourceMetadataOf, resourceOf } from '@sidequest/serving/Endpoints'
import { servingRevisions } from '@sidequest/serving/Revisions'
import { ByteSize, Effect, Layer, Option } from 'effect'
import { McpProtocol, McpServer } from 'effect/ai'
import * as HttpIncomingMessage from 'effect/http/HttpIncomingMessage'
import * as HttpRouter from 'effect/http/HttpRouter'
import { HttpServerRequest } from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { accessPattern } from '../OAuth/OAuthRoutes.ts'
import { Connections } from '../OAuth/Connections.ts'
import { McpCaller } from './Acting.ts'
import { GatewayHandlers } from './Handlers.ts'
import { GatewayToolkit } from './Tools.ts'

const instructions = [
  'You are an agent on Sidequest, a marketplace where people hire each other, paid through an on-chain escrow.',
  'You hold your own Nostr key here and sign as it, under a grant your operator signed: what you may do is that',
  'grant’s scopes (discuss, propose, accept, deliver), and it stops the moment they revoke it. Call `whoami`.',
  'Nothing you sign binds: only the buyer’s wallet funding the escrow makes a job real, and you never pay or sign',
  'with a wallet. Refusals come back as tool errors with a `reason`, and the core’s own reason in `core`.',
  'A pay-per-call (x402) listing is one paid call with no escrow and no refund: `x402_quote` answers what your',
  'operator’s wallet must sign to pay it, and `x402_receipt` records the payment afterwards.',
].join(' ')

/** The largest MCP request body read. */
const maxBody = ByteSize.kibibytes(256)

const challenge = (origin: string, invalid: boolean) =>
  HttpServerResponse.jsonUnsafe(
    invalid
      ? { error: 'invalid_token', error_description: 'The access token is unknown, expired or revoked.' }
      : { error: 'unauthorized', error_description: 'Send an access token as `Authorization: Bearer <token>`.' },
    {
      status: 401,
      headers: {
        'cache-control': 'no-store',
        'www-authenticate': `Bearer realm="sidequest-gateway", resource_metadata="${protectedResourceMetadataOf(origin)}"${
          invalid ? ', error="invalid_token"' : ''
        }`,
      },
    },
  )

/**
 * Admits an MCP request only with an access token this gateway issued for this origin's `/mcp`, whose connection
 * stands, and provides its agent and operator as the {@link McpCaller}. Whether the agent may act is the grant gate's
 * question, asked by every tool call.
 */
const BearerAuth = HttpRouter.middleware(
  Effect.gen(function* () {
    const connections = yield* Connections
    return (served) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest
        const origin = new URL(request.originalUrl).origin
        const token = /^Bearer +(\S+)\s*$/iu.exec(request.headers.authorization ?? '')?.[1]
        if (token === undefined) return challenge(origin, false)
        if (!accessPattern.test(token)) return challenge(origin, true)
        const found = yield* connections
          .access(yield* hashOf(token), yield* nowSeconds)
          .pipe(Effect.catchTag('Unavailable', () => Effect.succeed(Option.none())))
        if (Option.isNone(found) || found.value.connection.resource !== resourceOf(origin))
          return challenge(origin, true)
        const { agent, operator } = found.value.connection
        return yield* servingRevisions(served).pipe(
          Effect.provideService(McpCaller, Option.some({ agent, operator })),
          Effect.provideService(HttpIncomingMessage.MaxBodySize, maxBody),
        )
      })
  }),
)

/**
 * The gateway's MCP endpoint: stateless Streamable HTTP (revision 2026-07-28), with the older revisions served in
 * front of it without sessions (`@sidequest/serving/Revisions`), exactly as the core serves its own.
 */
export const mcpRoutes = (release: string) =>
  Layer.mergeAll(
    McpServer.layerHttpRequestScoped({
      name: 'sidequest-gateway',
      version: release,
      instructions,
      path: mcpPath,
      protocols: [McpProtocol.v2026_07_28],
    }).pipe(Layer.provide(BearerAuth.layer)),
    McpServer.toolkit(GatewayToolkit).pipe(Layer.provide(GatewayHandlers)),
  )
