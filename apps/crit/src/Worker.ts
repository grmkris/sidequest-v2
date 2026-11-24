/**
 * crit's Worker: one address for everything, routed by path (stack.ts deploys it once).
 *
 * | Path                                   | Who                                   | Guard                                 |
 * | -------------------------------------- | ------------------------------------- | ------------------------------------- |
 * | `/`, `/<slug>/…`                       | the team: the index and every page    | Cloudflare Access, and its token here |
 * | `/<slug>/_crit/comments`               | members' comments                     | the same                              |
 * | `/_crit/pages/<slug>/…`                | the index's buttons (Team.ts)         | the same, and the request's origin    |
 * | `/p/<slug>/…`                          | anyone: public pages                  | the page is `public`                  |
 * | `/s/<token>/<slug>/…`                  | anyone with the link                  | the link's token                      |
 * | `/api/*`, `/mcp`                       | agents (Api.ts, Mcp.ts)               | the publish token                     |
 * | `/lib/*`                               | everyone                              | none                                  |
 *
 * Cloudflare Access stands in front of the private paths and lets the others through (stack.ts declares both). The
 * Worker does not rely on that: a private path answers only to a request whose Access token it has checked itself
 * (Access.ts), so an address Access does not cover, or a bypass set too wide, opens nothing. A site without Access
 * has no team side at all: its private paths are "not here".
 */
import { DateTime, Effect, Option } from 'effect'
import { admittedEmail } from './Access.ts'
import { api } from './Api.ts'
import { comments, commentsRest, guestOf, memberOf, nameOf } from './Comments.ts'
import { tokenHash } from './Crypto.ts'
import { type Env, hasTeam } from './Env.ts'
import { type Address, addressOf, publicAddressOf, sharedAddressOf } from './Files.ts'
import { attempt, problem, text } from './Http.ts'
import { libFile } from './Lib.ts'
import { mcp } from './Mcp.ts'
import type { PageView } from './Model.ts'
import { servePage } from './Serve.ts'
import { indexPage, notHere, notice } from './Shell.ts'
import { listedPages, pageOf, sharedPage, viewOf } from './Store.ts'
import { sweep } from './Sweep.ts'
import { teamControl } from './Team.ts'

const reading = (request: Request) => request.method === 'GET' || request.method === 'HEAD'

/** A visitor's page (public, or by a share link): its files, and its comments under `…/_crit/comments`. */
const visitorPage = Effect.fn('crit.visitor')(function* (
  request: Request,
  env: Env,
  url: URL,
  page: PageView,
  address: Address,
  base: string,
  linkHash: string,
) {
  const rest = commentsRest(address.path)
  if (rest !== undefined) {
    return yield* comments(request, env, yield* guestOf(request, env, page.slug, linkHash), url, rest)
  }
  if (!reading(request)) return text('Method not allowed.', 405)
  return yield* servePage(request, env, page, address, base)
})

const shared = Effect.fn('crit.shared')(function* (request: Request, env: Env, url: URL) {
  const where = sharedAddressOf(url.pathname)
  if (where === undefined || env.OUTSIDERS === 'none') return notHere()
  // The token opens exactly one page: a wrong, revoked or other page's token is the same "not here".
  const hash = yield* attempt(() => tokenHash(where.token))
  const page = yield* sharedPage(env.DB, hash, where.address.slug)
  if (Option.isNone(page)) return notHere()
  const base = `/s/${where.token}/${where.address.slug}/`
  return yield* visitorPage(request, env, url, viewOf(page.value), where.address, base, hash)
})

const published = Effect.fn('crit.public')(function* (request: Request, env: Env, url: URL) {
  const address = publicAddressOf(url.pathname)
  if (address === undefined || env.PUBLIC_PAGES !== 'on') return notHere()
  const page = yield* pageOf(env.DB, address.slug)
  // A page the team has not opened is the same "not here" as a page that does not exist.
  if (Option.isNone(page) || page.value.visibility !== 'public') return notHere()
  const view = viewOf(page.value)
  return yield* visitorPage(request, env, url, view, address, `/p/${view.slug}/`, `public:${view.slug}`)
})

/** The team side, for the member whose Access token was checked. */
const team = Effect.fn('crit.team')(function* (request: Request, env: Env, url: URL, email: string) {
  const control = teamControl(request, env, url, nameOf(env, email))
  if (control !== undefined) return yield* control
  if (url.pathname === '/') {
    if (!reading(request)) return text('Method not allowed.', 405)
    const pages = (yield* listedPages(env.DB, false)).map(viewOf)
    return indexPage(env.TITLE, env.LEAD, pages, {
      publicPages: env.PUBLIC_PAGES === 'on',
      sharing: env.OUTSIDERS !== 'none',
      activeTag: url.searchParams.get('tag')?.trim().toLowerCase() || undefined,
    })
  }
  const address = addressOf(url.pathname)
  if (address === undefined) return notHere()
  const page = yield* pageOf(env.DB, address.slug)
  if (Option.isNone(page)) return notHere()
  const rest = commentsRest(address.path)
  if (rest !== undefined) {
    return yield* comments(request, env, yield* memberOf(env, email, address.slug), url, rest)
  }
  if (!reading(request)) return text('Method not allowed.', 405)
  return yield* servePage(request, env, viewOf(page.value), address, `/${address.slug}/`)
})

/** Private answers are for this origin's own pages only: no other site may embed or read them. */
const privately = (response: Response): Response => {
  const headers = new Headers(response.headers)
  headers.set('cross-origin-resource-policy', 'same-origin')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

const guarded = Effect.fn('crit.guarded')(function* (request: Request, env: Env, url: URL) {
  // No Access on this site: there is no team side, and nothing private to find.
  if (!hasTeam(env)) return notHere()
  const now = DateTime.toEpochMillis(yield* DateTime.now) / 1000
  const email = yield* attempt(() => admittedEmail(request, env, now))
  if (Option.isNone(email)) {
    return privately(notice(403, 'Sign-in required', 'This page opens only through the team sign-in.'))
  }
  return privately(yield* team(request, env, url, email.value))
})

const route = Effect.fn('crit.route')(function* (request: Request, env: Env) {
  const url = new URL(request.url)
  const path = url.pathname
  if (path.startsWith('/api/')) return yield* api(request, env, url)
  if (path === '/mcp') return yield* mcp(request, env, url)
  if (path.startsWith('/lib/')) return (reading(request) ? libFile(request, path) : undefined) ?? notHere()
  if (path.startsWith('/s/')) return yield* shared(request, env, url)
  if (path.startsWith('/p/')) return yield* published(request, env, url)
  // `/p` and `/s` alone are nobody's page: Access's open paths begin one segment further in.
  if (path === '/p' || path === '/s') return notHere()
  return yield* guarded(request, env, url)
})

export default {
  fetch: (request, env) =>
    Effect.runPromise(
      route(request, env).pipe(
        Effect.catchTag('Refused', (failure) => Effect.succeed(problem(failure))),
        Effect.catchTag('Unavailable', (failure) =>
          Effect.logError('crit unavailable', failure.cause).pipe(Effect.as(text('Something went wrong.', 500))),
        ),
      ),
    ),
  /** The cron (stack.ts): expired pages, old versions and unused files go. */
  scheduled: (_controller, env, ctx) => {
    ctx.waitUntil(
      Effect.runPromise(
        sweep(env).pipe(
          Effect.flatMap((done) => Effect.logInfo('crit sweep', done)),
          Effect.catchTag('Unavailable', (failure) => Effect.logError('crit sweep failed', failure.cause)),
        ),
      ),
    )
  },
} satisfies ExportedHandler<Env>
