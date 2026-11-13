import { x402Headers } from '@sidequest/protocol'
import { Context, Duration, Effect, Layer, Option } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpClient from 'effect/http/HttpClient'

// The gateway asks a seller's x402 resource for its price: one unpaid GET, whose 402 carries the challenge in its
// `PAYMENT-REQUIRED` header. It never pays and never sends a payment: the agent's key holds no money.

/** The longest challenge header read: a challenge with a few offers is well under a kilobyte. */
export const maxChallengeLength = 16 * 1024

/** How long the seller's host has to answer. */
const fetchTimeoutMs = 10_000

/**
 * Whether `url` is a resource the gateway asks: HTTPS, a host name rather than an address or `localhost`, the default
 * port, no credentials, no fragment. A Worker's `fetch` reaches the public internet only (`global_fetch_strictly_public`),
 * so this is the second fence, not the only one.
 */
export const isResourceUrl = (resource: string): boolean => {
  if (resource.length > 2000 || !URL.canParse(resource)) return false
  const url = new URL(resource)
  return (
    url.protocol === 'https:' &&
    url.port === '' &&
    url.hash === '' &&
    url.username === '' &&
    url.password === '' &&
    url.hostname !== 'localhost' &&
    !url.hostname.endsWith('.localhost') &&
    !/^[\d.]+$/u.test(url.hostname) &&
    !url.hostname.startsWith('[')
  )
}

/** What the resource answered to an unpaid GET: its status and its `PAYMENT-REQUIRED` header, if it sent one. */
export interface Answered {
  readonly status: number
  readonly challenge: Option.Option<string>
}

/**
 * Asks a resource for its challenge: a GET with no cookie, no credential and no body, not following a redirect,
 * within ten seconds. The body is never read; only the status and the challenge header, at most
 * {@link maxChallengeLength} long, are kept. A URL that is not a resource URL, silence or a failure answers nothing.
 */
export class ChallengeFetch extends Context.Service<
  ChallengeFetch,
  { readonly ask: (url: string) => Effect.Effect<Option.Option<Answered>> }
>()('Sidequest/Gateway/ChallengeFetch') {
  static readonly layer = Layer.effect(
    ChallengeFetch,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      return {
        ask: (url: string) =>
          isResourceUrl(url)
            ? client.get(url, { headers: { accept: 'application/json' } }).pipe(
                Effect.map((response) =>
                  Option.some({
                    status: response.status,
                    challenge: Option.filter(
                      Option.fromNullishOr(response.headers[x402Headers.required.toLowerCase()]),
                      (header) => header.length <= maxChallengeLength,
                    ),
                  }),
                ),
                Effect.timeout(Duration.millis(fetchTimeoutMs)),
                Effect.provideService(FetchHttpClient.RequestInit, { redirect: 'manual', credentials: 'omit' }),
                Effect.orElseSucceed(() => Option.none<Answered>()),
              )
            : Effect.succeedNone,
      }
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer))
}
