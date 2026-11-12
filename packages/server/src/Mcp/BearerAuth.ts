import { ByteSize, Effect, Option, Predicate, Result } from 'effect'
import * as HttpIncomingMessage from 'effect/http/HttpIncomingMessage'
import * as HttpRouter from 'effect/http/HttpRouter'
import { HttpServerRequest } from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { AgentAccess, bearerOf, type DenialReason } from '../Agents/AgentAccess.ts'
import { protectedResourceMetadataOf } from '../OAuth/Endpoints.ts'
import { McpCaller } from './McpCaller.ts'
import { servingRevisions } from './Revisions.ts'

/** The largest MCP request body read: room for the largest valid proposal, escaped, and no more. */
export const maxRequestBytes = 1024 * 1024
const maxBody = ByteSize.bytes(maxRequestBytes)

/**
 * The scheme and realm of every challenge, and where the client finds how to get a token: the RFC 9728 metadata of
 * this site's MCP endpoint, which MCP clients read to start OAuth.
 */
const realmOf = (origin: string) =>
  `Bearer realm="sidequest", resource_metadata="${protectedResourceMetadataOf(origin)}"`

/**
 * Why each denial refuses the token, for the `error_description` an agent's developer reads. RFC 6750 allows only
 * printable ASCII there, without a double quote or a backslash.
 */
const described: Readonly<Record<DenialReason, string>> = {
  unknown_token: 'The access token is unknown, expired or revoked.',
  wrong_resource: 'The access token was issued for another resource.',
  unknown_agent: 'The access token names no registered agent.',
  agent_revoked: 'The agent was revoked by its operator.',
  no_grant: 'The agent has no grant yet.',
  grant_expired: "The agent's grant has expired.",
}

/**
 * A 401 with the RFC 6750 challenge: no `error` when the request carried no bearer token (§3.1), `invalid_token`
 * when it carried one the server does not accept.
 */
const challenge = (origin: string, denied?: DenialReason) =>
  HttpServerResponse.jsonUnsafe(
    denied === undefined
      ? { error: 'unauthorized', error_description: 'Send an agent access token as `Authorization: Bearer <token>`.' }
      : { error: 'invalid_token', error_description: described[denied] },
    {
      status: 401,
      headers: {
        'cache-control': 'no-store',
        'www-authenticate':
          denied === undefined
            ? realmOf(origin)
            : `${realmOf(origin)}, error="invalid_token", error_description="${described[denied]}"`,
      },
    },
  )

/** Whether the declared body is larger than the MCP endpoint reads. */
const tooLarge = (contentLength: string | undefined) =>
  contentLength !== undefined && !(Number(contentLength) <= maxRequestBytes)

/**
 * Admits an MCP request only with an agent's access token, as an OAuth 2.0 bearer credential (RFC 6750) in the
 * `Authorization` header, and provides the agent it lets in as the {@link McpCaller}. The session cookie is never read
 * here: a browser attaches cookies by itself but never a bearer token, so nothing another site makes a browser send
 * can act as anyone. The body is read up to {@link maxRequestBytes}; a larger declared body is refused before reading.
 */
export const BearerAuth = HttpRouter.middleware(
  Effect.gen(function* () {
    const access = yield* AgentAccess
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest
        if (tooLarge(request.headers['content-length'])) return HttpServerResponse.empty({ status: 413 })
        const url = new URL(request.originalUrl)
        const token = bearerOf(request.headers.authorization)
        if (Option.isNone(token)) return challenge(url.origin)
        const admitted = yield* Effect.result(access.admit(token.value, `${url.origin}${url.pathname}`))
        if (Result.isFailure(admitted)) {
          const { failure } = admitted
          return Predicate.isTagged(failure, 'AccessDenied')
            ? challenge(url.origin, failure.reason)
            : HttpServerResponse.empty({ status: 503 })
        }
        const caller = { ...admitted.success, origin: url.origin }
        return yield* servingRevisions(httpEffect).pipe(
          Effect.provideService(McpCaller, Option.some(caller)),
          Effect.provideService(HttpIncomingMessage.MaxBodySize, maxBody),
        )
      })
  }),
)
