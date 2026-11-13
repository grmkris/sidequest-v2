import { maxPeoplePerLookup } from '@sidequest/protocol'
import { Array, Duration, Effect, Option, Predicate } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import { fromString } from 'foldkit/url'
import { makeApi } from '../ApiClient.ts'
import type { SidequestApiClient } from '../Api.ts'
import { Preload } from '../Preload.ts'
import { buyersOf, searchOf } from '../page/Home.ts'
import { keysIn } from '../page/job/Job.ts'
import { AppRoute, routeFromUrl } from '../route.ts'

// What the website Worker reads from the API Worker, over its service binding, before it renders a page: the page's
// public data (requests, listings, jobs, names), and nothing personal. Nothing of the visitor's request is forwarded,
// cookies least of all: the server does not know who the visitor is. A read that fails or is slow leaves the page as
// the browser would build it without the server's help.

/** A Worker's service binding: requests to it reach the API Worker in process, without leaving Cloudflare. */
type ServiceBinding = { readonly fetch: (request: Request) => Promise<Response> }

const isServiceBinding = (value: unknown): value is ServiceBinding =>
  Predicate.hasProperty(value, 'fetch') && Predicate.isFunction(value.fetch)

/** The API Worker's binding, from workerd's `env` of the website Worker. Vite's dev server runs in Node, which has no
 * bindings: none. */
const apiBinding = Effect.tryPromise((): Promise<unknown> => import('cloudflare:workers')).pipe(
  Effect.map((runtime) =>
    Predicate.hasProperty(runtime, 'env') &&
    Predicate.hasProperty(runtime.env, 'API') &&
    isServiceBinding(runtime.env.API)
      ? Option.some(runtime.env.API)
      : Option.none(),
  ),
  Effect.orElseSucceed(() => Option.none<ServiceBinding>()),
)

/** How long the server waits for one page's reads before it renders without them. */
const patience = Duration.seconds(2)

/** The typed API client over the binding, sending nothing of the visitor's request. */
const clientOver = (binding: ServiceBinding, origin: string) =>
  makeApi(origin).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(
      FetchHttpClient.Fetch,
      Object.assign((input: RequestInfo | URL, init?: RequestInit) => binding.fetch(new Request(input, init)), {
        preconnect: () => undefined,
      }),
    ),
  )

/** The names of the keys a page shows, in one lookup. */
const named = (index: SidequestApiClient, pubkeys: ReadonlyArray<string>) =>
  Array.match(Array.take(Array.dedupe(pubkeys), maxPeoplePerLookup), {
    onEmpty: () => Effect.succeed([]),
    onNonEmpty: (unique) => Effect.map(index.events.people({ query: { pubkeys: unique } }), ({ people }) => people),
  })

/** The data the page at `route` shows; nothing for a page that reads none. */
const preloadFor = (index: SidequestApiClient, route: AppRoute): Effect.Effect<Preload, unknown> =>
  AppRoute.match<Effect.Effect<Preload, unknown>>(route, {
    Home: ({ q }) =>
      Effect.gen(function* () {
        const [requests, listings] = yield* Effect.all(
          [
            index.indexJobs.openJobs({ query: { stage: 'open', expired: 'exclude' } }),
            index.events.listings({ query: { q: Option.getOrUndefined(searchOf(q)) } }),
          ],
          { concurrency: 'unbounded' },
        )
        const names = yield* named(index, buyersOf(requests.items))
        return Preload.Home({ requests, listings, names })
      }),
    Listing: ({ pubkey, slug }) =>
      Effect.map(index.events.listing({ params: { pubkey, slug } }), (listing) => Preload.Listing({ listing })),
    Job: ({ job }) =>
      Effect.gen(function* () {
        const view = yield* index.indexJobs.job({ params: { id: job } })
        return Preload.Job({ view, names: yield* named(index, keysIn(view)) })
      }),
    // The person is their signer, in their browser: what is theirs is read there.
    Inbox: () => Effect.succeed(Preload.Nothing()),
    Agents: () => Effect.succeed(Preload.Nothing()),
    NewListing: () => Effect.succeed(Preload.Nothing()),
    NewRequest: () => Effect.succeed(Preload.Nothing()),
    // The signer lives in the browser; nothing about it is known before hydration.
    Identity: () => Effect.succeed(Preload.Nothing()),
    Evidence: () => Effect.succeed(Preload.Nothing()),
    NotFound: () => Effect.succeed(Preload.Nothing()),
  })

/** Read the data of the page `request` asks for over the API Worker's binding. Without a binding, or on any failure,
 * nothing. */
export const pageData = (request: Request): Effect.Effect<Preload> =>
  Effect.gen(function* () {
    const binding = yield* apiBinding
    if (Option.isNone(binding)) return Preload.Nothing()
    const url = new URL(request.url)
    const route = Option.match(fromString(request.url), {
      onNone: () => AppRoute.NotFound({ path: url.pathname }),
      onSome: routeFromUrl,
    })
    const index = yield* clientOver(binding.value, url.origin)
    return yield* preloadFor(index, route).pipe(Effect.orElseSucceed(() => Preload.Nothing()))
  }).pipe(
    Effect.timeoutOrElse({ duration: patience, orElse: () => Effect.succeed(Preload.Nothing()) }),
    Effect.orElseSucceed(() => Preload.Nothing()),
  )
