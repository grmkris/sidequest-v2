import type { UnixSeconds } from '@sidequest/protocol'
import { Option, Result, Schema } from 'effect'
import { Base64 } from 'effect/encoding'
import type { EventTemplate, NostrEvent } from './Event.ts'
import type { PublicKey } from './Keys.ts'
import { verifyEvent } from './Verify.ts'

/** NIP-98 HTTP auth, kind 27235 after RFC 7235. */
export const httpAuthKind = 27_235

/** Why a request's NIP-98 authorization is refused; a server answers each with 401. */
export class HttpAuthRefused extends Schema.TaggedError<HttpAuthRefused>()('HttpAuthRefused', {
  reason: Schema.Literals([
    'malformedHeader',
    'invalidEvent',
    'wrongKind',
    'stale',
    'urlMismatch',
    'methodMismatch',
    'payloadMismatch',
  ]),
}) {}

/** The request an authorization is for: the absolute URL with its query, the method, and the body's SHA-256 if any. */
export interface HttpRequestFacts {
  readonly url: string
  readonly method: string
  readonly payloadSha256?: string
}

/** The unsigned kind-27235 event authorizing one request at `createdAt`, with empty content as NIP-98 asks. */
export const httpAuthTemplate = (request: HttpRequestFacts, createdAt: UnixSeconds): EventTemplate => ({
  created_at: createdAt,
  kind: httpAuthKind,
  tags: [
    ['u', request.url],
    ['method', request.method],
    ...(request.payloadSha256 === undefined ? [] : [['payload', request.payloadSha256]]),
  ],
  content: '',
})

/** The `Authorization` header value for a signed authorization: `Nostr <base64 of the event's JSON>`. */
export const httpAuthHeader = (event: NostrEvent): string => `Nostr ${Base64.encode(JSON.stringify(event))}`

const parseJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))
const refuse = (reason: HttpAuthRefused['reason']) => Result.fail(new HttpAuthRefused({ reason }))
const tagValue = (event: NostrEvent, name: string) =>
  Option.fromNullishOr(event.tags.find((tag) => tag[0] === name)?.[1])

/**
 * The event inside an `Authorization: Nostr …` header. NIP-98's own example omits the base64 padding, so padding is
 * optional here.
 */
const eventOfHeader = (header: string): Result.Result<unknown, HttpAuthRefused> => {
  const match = /^Nostr ([A-Za-z0-9+/]+)={0,2}$/u.exec(header.trim())
  return Option.match(Option.fromNullishOr(match?.[1]), {
    onNone: () => refuse('malformedHeader'),
    onSome: (encoded) =>
      Result.mapError(
        Result.flatMap(Base64.decodeString(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')), parseJson),
        () => new HttpAuthRefused({ reason: 'malformedHeader' }),
      ),
  })
}

const checkEvent = (
  event: NostrEvent,
  request: HttpRequestFacts,
  now: UnixSeconds,
  windowSeconds: number,
): Result.Result<PublicKey, HttpAuthRefused> => {
  if (event.kind !== httpAuthKind) return refuse('wrongKind')
  if (Math.abs(now - event.created_at) > windowSeconds) return refuse('stale')
  if (!Option.contains(tagValue(event, 'u'), request.url)) return refuse('urlMismatch')
  if (!Option.contains(tagValue(event, 'method'), request.method)) return refuse('methodMismatch')
  const payload = Option.getOrUndefined(tagValue(event, 'payload'))
  if (payload !== request.payloadSha256) return refuse('payloadMismatch')
  return Result.succeed(event.pubkey)
}

/**
 * Who authorized this request, from its `Authorization` header: the event must verify, be kind 27235, be made within
 * `windowSeconds` of `now`, name exactly this URL and method, and carry a `payload` tag exactly when the request has a
 * body hash, equal to it. NIP-98 lets servers skip the payload check; this one never does.
 */
export const verifyHttpAuth = (
  header: string,
  request: HttpRequestFacts,
  now: UnixSeconds,
  windowSeconds: number,
): Result.Result<PublicKey, HttpAuthRefused> =>
  eventOfHeader(header).pipe(
    Result.flatMap((input) =>
      Result.mapError(verifyEvent(input), () => new HttpAuthRefused({ reason: 'invalidEvent' })),
    ),
    Result.flatMap((event) => checkEvent(event, request, now, windowSeconds)),
  )
