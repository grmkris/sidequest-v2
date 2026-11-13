import { httpAuthHeader, httpAuthTemplate } from '@sidequest/nostr'
import { textDigest } from '@sidequest/protocol'
import { Context, Effect, Layer, Option, Schema } from 'effect'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import { defineTaggedUnion } from 'foldkit/schema'
import type { Language } from './Language.ts'
import { nowSeconds } from './Publishing.ts'
import { type SignerFailed, Signers } from './Signer.ts'
import { say } from './Text.ts'

// The agent gateway's operator API (apps/gateway), reached through the edge's same-origin proxy at `/gateway`: the
// site's CSP allows no other origin. The operator is the person's Nostr key, with no account and no session: every
// request carries a NIP-98 authorization of exactly that request, which the person's signer makes for the URL the page
// calls here, and which the gateway accepts as naming itself.

/** How the gateway, or the proxy in front of it, refused a request. */
export const GatewayRefusal = defineTaggedUnion({
  /** The stage has no gateway: the proxy answers for none. */
  NotConfigured: {},
  /** The authorization did not prove the key: missing, stale, for another request, or used before. */
  Unauthorized: { reason: Schema.String },
  /** No such agent of this operator, or no such delegation. */
  UnknownAgent: {},
  TooManyAgents: {},
  /** The gateway did not take what was sent. */
  Invalid: {},
  /** The gateway's database did not answer. */
  Unavailable: {},
  /** The gateway did not answer, or answered with something that is not its API's. */
  Unreachable: {},
})
export type GatewayRefusal = typeof GatewayRefusal.Type

export class GatewayRefused extends Schema.TaggedError<GatewayRefused>()('GatewayRefused', {
  refusal: GatewayRefusal,
}) {}

const Refusal = Schema.Struct({ error: Schema.String, reason: Schema.optional(Schema.String) })
const decodeRefusal = Schema.decodeUnknownOption(Refusal)

/** A gateway answer that is not a success, by its status and its `error`. */
export const refusalOf = (status: number, body: unknown): GatewayRefusal => {
  const answered = decodeRefusal(body)
  const error = Option.match(answered, { onNone: () => '', onSome: (refusal) => refusal.error })
  if (error === 'gateway_not_configured') return GatewayRefusal.NotConfigured()
  if (status === 401) {
    return GatewayRefusal.Unauthorized({
      reason: Option.getOrElse(
        Option.flatMap(answered, (refusal) => Option.fromNullishOr(refusal.reason)),
        () => 'missing',
      ),
    })
  }
  if (error === 'unknown_agent' || error === 'unknown_delegation') return GatewayRefusal.UnknownAgent()
  if (error === 'too_many_agents') return GatewayRefusal.TooManyAgents()
  if (status === 400) return GatewayRefusal.Invalid()
  if (status === 503) return GatewayRefusal.Unavailable()
  return GatewayRefusal.Unreachable()
}

/** The gateway's refusal in one sentence. */
export const gatewayRefusalText = (language: Language, refusal: GatewayRefusal): string =>
  GatewayRefusal.match(refusal, {
    NotConfigured: () => say(language, 'gateway.notConfigured'),
    Unauthorized: () => say(language, 'gateway.unauthorized'),
    UnknownAgent: () => say(language, 'gateway.unknownAgent'),
    TooManyAgents: () => say(language, 'gateway.tooManyAgents'),
    Invalid: () => say(language, 'gateway.invalid'),
    Unavailable: () => say(language, 'gateway.unavailable'),
    Unreachable: () => say(language, 'gateway.unreachable'),
  })

export type GatewayMethod = 'GET' | 'POST' | 'DELETE'

export class Gateway extends Context.Service<
  Gateway,
  {
    /** One operator request: `path` under `/api/agents`, with a JSON body for a POST. Answers the gateway's JSON, or
     * `null` for an answer without a body. */
    readonly send: (
      method: GatewayMethod,
      path: string,
      maybeBody: Option.Option<unknown>,
    ) => Effect.Effect<unknown, GatewayRefused | SignerFailed>
  }
>()('@sidequest/web/Gateway') {}

const unreachable = () => new GatewayRefused({ refusal: GatewayRefusal.Unreachable() })

/** The gateway through this site's proxy at `origin`, signing with the person's signer. */
export const gatewayLayer = (origin: string) =>
  Layer.effect(
    Gateway,
    Effect.gen(function* () {
      const signers = yield* Signers
      const http = yield* HttpClient.HttpClient
      return Gateway.of({
        send: (method, path, maybeBody) =>
          Effect.gen(function* () {
            const url = `${origin}/gateway${path}`
            const maybeText = Option.map(maybeBody, (body) => JSON.stringify(body))
            const payload = yield* Option.match(maybeText, {
              onNone: () => Effect.succeed({}),
              onSome: (text) => Effect.map(textDigest(text), (payloadSha256) => ({ payloadSha256 })),
            })
            const signer = yield* signers.resume
            const event = yield* signer.signEvent(httpAuthTemplate({ url, method, ...payload }, yield* nowSeconds))
            const request = HttpClientRequest.make(method)(url).pipe(
              HttpClientRequest.setHeader('authorization', httpAuthHeader(event)),
              (made) =>
                Option.match(maybeText, {
                  onNone: () => made,
                  onSome: (text) => HttpClientRequest.bodyText(made, text, 'application/json'),
                }),
            )
            const response = yield* Effect.mapError(http.execute(request), unreachable)
            const body = response.status === 204 ? null : yield* Effect.orElseSucceed(response.json, () => null)
            if (response.status >= 200 && response.status < 300) return body
            return yield* new GatewayRefused({ refusal: refusalOf(response.status, body) })
          }),
      })
    }),
  )
