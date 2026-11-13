import { maxPeoplePerLookup, sessionCookieName } from '@sidequest/protocol'
import { Array, Duration, Effect, Option, Predicate } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import { fromString } from 'foldkit/url'
import { makeApi } from '../ApiClient.ts'
import type { SidequestApiClient } from '../Api.ts'
import { Preload, SessionRead } from '../Preload.ts'
import { buyersOf, searchOf } from '../page/Home.ts'
import { keysIn } from '../page/job/Job.ts'
import { AppRoute, routeFromUrl } from '../route.ts'

// What the website Worker reads from the API Worker, over its service binding, before it renders a page: the session
// when the request carries its cookie, and the page's data. The session cookie goes only with the phase 1 session and
// the pages still on it (inbox, agents); the index's reads (requests, listings, jobs, names) are public and go without
// it. Nothing else of the request is forwarded. A read that fails or is slow leaves the page as the browser would build
// it without the server's help.

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

/** The `name=value` pair of the session cookie in a `Cookie` header, if the request carries one. */
export const sessionCookieOf = (cookieHeader: string | null): Option.Option<string> =>
  Array.findFirst((cookieHeader ?? '').split(';'), (pair) => pair.trim().startsWith(`${sessionCookieName}=`)).pipe(
    Option.map((pair) => pair.trim()),
  )

/** How long the server waits for one page's reads before it renders without them. */
const patience = Duration.seconds(2)

/** The typed API client over the binding, sending the session cookie and nothing else of the visitor's request. */
const clientOver = (binding: ServiceBinding, origin: string, cookie: Option.Option<string>) =>
  makeApi(origin).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(
      FetchHttpClient.Fetch,
      Object.assign((input: RequestInfo | URL, init?: RequestInit) => binding.fetch(new Request(input, init)), {
        preconnect: () => undefined,
      }),
    ),
    Effect.provideService(
      FetchHttpClient.RequestInit,
      Option.match(cookie, { onNone: () => ({}), onSome: (pair) => ({ headers: { cookie: pair } }) }),
    ),
  )

/** The names of the keys a page shows, in one lookup. */
const named = (index: SidequestApiClient, pubkeys: ReadonlyArray<string>) =>
  Array.match(Array.take(Array.dedupe(pubkeys), maxPeoplePerLookup), {
    onEmpty: () => Effect.succeed([]),
    onNonEmpty: (unique) => Effect.map(index.events.people({ query: { pubkeys: unique } }), ({ people }) => people),
  })

/** The clients a page reads with: the public index's, which carries nothing of the visitor, and the session's. */
interface Readers {
  readonly index: SidequestApiClient
  readonly session: SidequestApiClient
}

/** The data the page at `route` shows; nothing for a page that reads none. */
const preloadFor = ({ index, session }: Readers, route: AppRoute, signedIn: boolean): Effect.Effect<Preload, unknown> =>
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
    Inbox: () =>
      signedIn
        ? Effect.map(session.inbox.recent({ query: {} }), (recent) => Preload.Inbox({ recent }))
        : Effect.succeed(Preload.Nothing()),
    Agents: () =>
      signedIn
        ? Effect.map(session.agents.list({ query: { limit: 50 } }), (agents) => Preload.Agents({ agents }))
        : Effect.succeed(Preload.Nothing()),
    SignIn: () => Effect.succeed(Preload.Nothing()),
    NewListing: () => Effect.succeed(Preload.Nothing()),
    NewRequest: () => Effect.succeed(Preload.Nothing()),
    // The consent page and the connected apps read after hydration, as their own person.
    Connect: () => Effect.succeed(Preload.Nothing()),
    Connections: () => Effect.succeed(Preload.Nothing()),
    // The signer lives in the browser; nothing about it is known before hydration.
    Identity: () => Effect.succeed(Preload.Nothing()),
    Evidence: () => Effect.succeed(Preload.Nothing()),
    NotFound: () => Effect.succeed(Preload.Nothing()),
  })

/** Who the session cookie signs in: someone, no one (the API refused it), or not known (no cookie, or no answer). */
const sessionFor = (api: SidequestApiClient, cookie: Option.Option<string>) =>
  Option.isNone(cookie)
    ? Effect.succeed(SessionRead.Unread())
    : api.session.current().pipe(
        Effect.map((session) => SessionRead.SignedIn({ session })),
        Effect.catchTag('NotSignedIn', () => Effect.succeed(SessionRead.SignedOut())),
        Effect.orElseSucceed(() => SessionRead.Unread()),
      )

/** What the server read for a page: the session and the page's data. Without a binding, or on any failure, nothing. */
export interface PageData {
  readonly sessionRead: SessionRead
  readonly preload: Preload
}

const nothing: PageData = { sessionRead: SessionRead.Unread(), preload: Preload.Nothing() }

/** Read the session and the data of the page `request` asks for, as its visitor, over the API Worker's binding. */
export const pageData = (request: Request): Effect.Effect<PageData> =>
  Effect.gen(function* () {
    const binding = yield* apiBinding
    if (Option.isNone(binding)) return nothing
    const url = new URL(request.url)
    const route = Option.match(fromString(request.url), {
      onNone: () => AppRoute.NotFound({ path: url.pathname }),
      onSome: routeFromUrl,
    })
    const cookie = sessionCookieOf(request.headers.get('cookie'))
    const session = yield* clientOver(binding.value, url.origin, cookie)
    const index = yield* clientOver(binding.value, url.origin, Option.none())
    const sessionRead = yield* sessionFor(session, cookie)
    const preload = yield* preloadFor({ index, session }, route, SessionRead.guards.SignedIn(sessionRead)).pipe(
      Effect.orElseSucceed(() => Preload.Nothing()),
    )
    return { sessionRead, preload }
  }).pipe(
    Effect.timeoutOrElse({ duration: patience, orElse: () => Effect.succeed(nothing) }),
    Effect.orElseSucceed(() => nothing),
  )
