import { ConnectRequestId, Hex32, IndexListingSlug } from '@sidequest/protocol'
import { Option, pipe, Schema } from 'effect'
import { Route } from 'foldkit'
import { defineRouteUnion, literal, schemaSegment, slash } from 'foldkit/route'
import type { Url } from 'foldkit/url'

export const AppRoute = defineRouteUnion({
  Home: { q: Schema.Option(Schema.String) },
  SignIn: { next: Schema.Option(Schema.String) },
  NewListing: {},
  Listing: { pubkey: Hex32, slug: IndexListingSlug },
  NewRequest: {},
  Job: { job: Hex32 },
  Inbox: {},
  Agents: {},
  Connect: { request: ConnectRequestId },
  Connections: {},
  Identity: { next: Schema.Option(Schema.String) },
  Evidence: {},
  NotFound: { path: Schema.String },
})
export type AppRoute = typeof AppRoute.Type

export const homeRouter = pipe(
  Route.root,
  Route.query(Schema.Struct({ q: Schema.OptionFromOptional(Schema.String) })),
  Route.mapTo(AppRoute.Home),
)
const signInRouter = pipe(
  literal('sign-in'),
  Route.query(Schema.Struct({ next: Schema.OptionFromOptional(Schema.String) })),
  Route.mapTo(AppRoute.SignIn),
)
export const newListingRouter = pipe(literal('listings'), slash(literal('new')), Route.mapTo(AppRoute.NewListing))
/** A seller's listing, by their key and the listing's slug: the same page for every version they publish. */
export const listingRouter = pipe(
  literal('listings'),
  slash(schemaSegment('pubkey', Hex32)),
  slash(schemaSegment('slug', IndexListingSlug)),
  Route.mapTo(AppRoute.Listing),
)
export const newRequestRouter = pipe(literal('requests'), slash(literal('new')), Route.mapTo(AppRoute.NewRequest))
/** The job page, at its request event's id, which is the job's id (ADR-0003, decision 3). */
export const jobRouter = pipe(literal('jobs'), slash(schemaSegment('job', Hex32)), Route.mapTo(AppRoute.Job))
export const inboxRouter = pipe(literal('inbox'), Route.mapTo(AppRoute.Inbox))
export const agentsRouter = pipe(literal('agents'), Route.mapTo(AppRoute.Agents))
/** The apps a person connected to their agents over OAuth. */
export const connectionsRouter = pipe(
  literal('agents'),
  slash(literal('connections')),
  Route.mapTo(AppRoute.Connections),
)
/** The consent page an MCP client's authorization request waits on. The server sends the browser here (`/connect/<id>`). */
export const connectRouter = pipe(
  literal('connect'),
  slash(schemaSegment('request', ConnectRequestId)),
  Route.mapTo(AppRoute.Connect),
)

/** The person's Nostr identity: their signer, their profile and their wallet's link; `next` is where they came from. */
export const identityRouter = pipe(
  literal('identity'),
  Route.query(Schema.Struct({ next: Schema.OptionFromOptional(Schema.String) })),
  Route.mapTo(AppRoute.Identity),
)

/** Where anyone checks a disclosed room message: author, time and text, from the bundle alone. */
export const evidenceRouter = pipe(literal('evidence'), Route.mapTo(AppRoute.Evidence))

const routeParser = Route.oneOf(
  evidenceRouter,
  newListingRouter,
  listingRouter,
  newRequestRouter,
  jobRouter,
  inboxRouter,
  connectionsRouter,
  agentsRouter,
  connectRouter,
  identityRouter,
  signInRouter,
  homeRouter,
)

export const routeFromUrl: (url: Url) => AppRoute = Route.parseUrlWithFallback(routeParser, AppRoute.NotFound)

/** Where a route lives, for a link back to it after signing in. */
const pathOf = (route: AppRoute): string =>
  AppRoute.match(route, {
    Home: (home) => homeRouter(home),
    SignIn: () => homeRouter({ q: Option.none() }),
    NewListing: () => newListingRouter(),
    Listing: (listing) => listingRouter(listing),
    NewRequest: () => newRequestRouter(),
    Job: ({ job }) => jobRouter({ job }),
    Inbox: () => inboxRouter(),
    Agents: () => agentsRouter(),
    Connect: ({ request }) => connectRouter({ request }),
    Connections: () => connectionsRouter(),
    Identity: (identity) => identityRouter(identity),
    Evidence: () => evidenceRouter(),
    NotFound: ({ path }) => path,
  })

/** Sign in, then come back to `route`. */
export const signInHref = (route: AppRoute): string => signInRouter({ next: Option.some(pathOf(route)) })

/** Set up a Nostr signer (or link a wallet), then come back to `route`. */
export const identityHref = (route: AppRoute): string => identityRouter({ next: Option.some(pathOf(route)) })

/** A path a sign-in or the identity page may return to: one of this site's own, never another origin. */
export const safeReturn = (next: Option.Option<string>): string =>
  Option.match(
    Option.filter(next, (path) => path.startsWith('/') && !path.startsWith('//')),
    { onNone: () => homeRouter({ q: Option.none() }), onSome: (path) => path },
  )
