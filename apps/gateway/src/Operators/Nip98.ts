import { type HttpRequestFacts, type PublicKey, verifyHttpAuth } from '@sidequest/nostr'
import { textDigest, type Unavailable } from '@sidequest/protocol'
import { nowSeconds } from '@sidequest/serving/Authorize'
import { stored } from '@sidequest/serving/Stored'
import { Context, Effect, Layer, Option, Result, Schema } from 'effect'
import { Base64 } from 'effect/encoding'
import type { HttpServerRequest } from 'effect/http/HttpServerRequest'
import * as SqlClient from 'effect/sql/SqlClient'
import { GatewaySettings } from '../Settings.ts'

/** How far a NIP-98 authorization's `created_at` may be from the gateway's clock. */
export const authWindowSeconds = 60

/** Why a request's NIP-98 authorization proves no key: missing, not valid for this request, or used before. */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()('Unauthorized', {
  reason: Schema.Literals([
    'missing',
    'malformedHeader',
    'invalidEvent',
    'wrongKind',
    'stale',
    'urlMismatch',
    'methodMismatch',
    'payloadMismatch',
    'replayed',
  ]),
}) {}

const decodeEventId = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)) })),
)

/** The id of the event inside an `Authorization: Nostr <base64>` header that already verified. */
const eventIdOf = (header: string) => {
  const encoded = header.trim().slice('Nostr '.length)
  return Option.flatMap(
    Result.getSuccess(Base64.decodeString(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '='))),
    decodeEventId,
  )
}

/** The prefix under which the core's edge proxies the operator's API to this gateway, on the core's own origin. */
const proxyPrefix = '/gateway'

/**
 * The URL a request to this gateway has on the core's origin, when the core's edge proxies it there
 * (`<core>/gateway/api/agents…` for `/api/agents…`): the website on that origin signs for the URL it calls.
 */
const proxiedUrlOf = (coreUrl: string, requestUrl: string): string => {
  const url = new URL(requestUrl)
  return `${coreUrl}${proxyPrefix}${url.pathname}${url.search}`
}

/** The key of an authorization made for the request as the gateway sees it, or for its URL through the core's proxy. */
const verifiedFor = (header: string, facts: HttpRequestFacts, proxiedUrl: string, now: number) => {
  const direct = verifyHttpAuth(header, facts, now, authWindowSeconds)
  return Result.isFailure(direct) && direct.failure.reason === 'urlMismatch'
    ? verifyHttpAuth(header, { ...facts, url: proxiedUrl }, now, authWindowSeconds)
    : direct
}

/**
 * Operators prove their key with NIP-98 (`HttpAuth.ts`): a kind-27235 event naming this exact URL and method, signed
 * within {@link authWindowSeconds}, with the SHA-256 of the body when there is one. A request that changes something
 * spends its authorization: the event's id is kept until it could no longer verify, so a captured header cannot be
 * sent again. There are no sessions and no cookies: each request carries its own proof.
 *
 * The `u` tag names either this gateway's own URL for the request, or the URL the core's edge proxies to it
 * ({@link proxiedUrlOf}): the gateway knows the core's URL, so both name this gateway and no other. The website, on the
 * core's origin, calls the gateway through that proxy (its CSP allows only its own origin) and signs for what it calls.
 */
export class OperatorAuth extends Context.Service<
  OperatorAuth,
  {
    /** The key that signed this request's authorization; `once` spends it, for a request that changes something. */
    readonly verify: (
      request: HttpServerRequest,
      body: string,
      once: boolean,
    ) => Effect.Effect<PublicKey, Unauthorized | Unavailable>
  }
>()('Sidequest/Gateway/OperatorAuth') {
  /** On D1 (`used_authorizations`); needs the database's `SqlClient`. */
  static readonly layer = Layer.effect(
    OperatorAuth,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const { coreUrl } = yield* GatewaySettings
      /** Records an authorization's event as used, or refuses it if it was used before. */
      const spend = Effect.fnUntraced(function* (header: string, now: number) {
        const spent = eventIdOf(header)
        if (Option.isNone(spent)) return yield* new Unauthorized({ reason: 'malformedHeader' })
        yield* stored(sql`DELETE FROM used_authorizations WHERE expires_at < ${now}`)
        const fresh = yield* stored(sql`
          INSERT INTO used_authorizations (event_id, expires_at) VALUES (${spent.value.id}, ${now + 2 * authWindowSeconds})
          ON CONFLICT (event_id) DO NOTHING RETURNING event_id`)
        if (fresh.length === 0) return yield* new Unauthorized({ reason: 'replayed' })
      })
      return OperatorAuth.of({
        verify: Effect.fn('Sidequest.Gateway.OperatorAuth.verify')(function* (request, body, once) {
          const header = request.headers.authorization
          if (header === undefined) return yield* new Unauthorized({ reason: 'missing' })
          const now = yield* nowSeconds
          const facts = {
            url: request.originalUrl,
            method: request.method,
            ...(body === '' ? {} : { payloadSha256: yield* textDigest(body) }),
          }
          const verified = verifiedFor(header, facts, proxiedUrlOf(coreUrl, request.originalUrl), now)
          if (Result.isFailure(verified)) return yield* new Unauthorized({ reason: verified.failure.reason })
          if (!once) return verified.success
          yield* spend(header, now)
          return verified.success
        }),
      })
    }),
  )
}
