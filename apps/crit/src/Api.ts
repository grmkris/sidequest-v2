/**
 * The agents' API, behind one bearer token (the `PUBLISH_TOKEN` secret, compared by hash).
 *
 * | Route                               | Result                                                             |
 * | ----------------------------------- | ------------------------------------------------------------------ |
 * | `POST /api/publish/plan`            | `{ page, manifest }` → `{ missing }`, the hashes to upload         |
 * | `PUT /api/blobs/<sha256>`           | the file's bytes → 201                                             |
 * | `POST /api/publish/commit`          | `{ page, manifest }` + `Idempotency-Key` → `{ page, replayed }`    |
 * | `GET /api/pages`                    | `{ pages }`, every live page                                       |
 * | `PATCH /api/pages/<slug>`           | `{ keep }` → `{ page }`: a kept page never expires                 |
 * | `DELETE /api/pages/<slug>`          | takes the page down → 204                                          |
 * | `POST /api/pages/<slug>/visibility` | `{ visibility }` → `{ page }`: `public` or `team`                  |
 * | `GET /api/pages/<slug>/links`       | `{ links }`: the ids and times of the links that work now          |
 * | `POST /api/pages/<slug>/links`      | `{ days? }` → `{ id, url, expiresAt }`, a new link, shown once     |
 * | `DELETE /api/pages/<slug>/links`    | revokes the page's links → `{ revoked }`                           |
 * | `DELETE /api/pages/<slug>/links/<id>` | revokes that one link → `{ revoked }`                            |
 * | `POST /api/sweep`                   | runs the clean-up now → `{ expired, blobs }`                       |
 *
 * Comments for agents (reading threads, replying) are CommentApi.ts's routes, and `/mcp` (Mcp.ts) offers the same to
 * MCP clients, all under the same token.
 */
import { Effect, Option, Schema } from 'effect'
import { commentApi } from './CommentApi.ts'
import { randomLinkId, randomToken, tokenHash } from './Crypto.ts'
import type { Env } from './Env.ts'
import { attempt, bodyOf, guardHeaders, json, refuse } from './Http.ts'
import { KeepRequest, LinkRequest, type Visibility, VisibilityRequest } from './Model.ts'
import { commit, plan, putBlob } from './Publish.ts'
import {
  addLink,
  linksOf,
  listedPages,
  pageOf,
  removePage,
  revokeLink,
  revokeLinks,
  setKeep,
  setVisibility,
  viewOf,
} from './Store.ts'
import { sweep } from './Sweep.ts'
import { afterDays, amountOf, nowIso } from './Time.ts'

const decodeKeep = Schema.decodeUnknownOption(KeepRequest)
const decodeLink = Schema.decodeUnknownOption(LinkRequest)
const decodeVisibility = Schema.decodeUnknownOption(VisibilityRequest)

export const authorized = Effect.fn('crit.api.authorize')(function* (request: Request, env: Env) {
  const secret = env.PUBLISH_TOKEN ?? ''
  const given = /^Bearer\s+(\S+)$/u.exec(request.headers.get('authorization') ?? '')?.[1]
  if (secret === '' || given === undefined) return yield* refuse(401, 'unauthorized')
  const [left, right] = yield* attempt(() => Promise.all([tokenHash(given), tokenHash(secret)]))
  if (left !== right) return yield* refuse(401, 'unauthorized')
})

/** A new share link for a live page. `days` undefined takes the site's `linkDays`; 0 is until revoked. */
export const makeLink = Effect.fn('crit.api.link')(function* (
  env: Env,
  origin: string,
  slug: string,
  days: number | undefined,
) {
  if (env.OUTSIDERS === 'none') return yield* refuse(403, 'sharing_is_off')
  if (Option.isNone(yield* pageOf(env.DB, slug))) return yield* refuse(404, 'page_not_found')
  const token = randomToken()
  const id = randomLinkId()
  const expiresAt = yield* afterDays(days ?? amountOf(env.LINK_DAYS))
  const hash = yield* attempt(() => tokenHash(token))
  yield* addLink(env.DB, { id, hash, slug, now: yield* nowIso, expiresAt })
  return { id, url: `${origin}/s/${token}/${slug}/`, expiresAt }
})

/** Every link of a page stops working, or the one link `id` names. */
export const revoke = Effect.fn('crit.api.revoke')(function* (env: Env, slug: string, id?: string) {
  const now = yield* nowIso
  return {
    revoked: id === undefined ? yield* revokeLinks(env.DB, slug, now) : yield* revokeLink(env.DB, slug, id, now),
  }
})

/**
 * Opens a page to anyone at `/p/<slug>/`, or closes it to the team. `by` is who decided: a member's name, or `agent`.
 * A site with public pages off refuses to open one.
 */
export const changeVisibility = Effect.fn('crit.api.visibility')(function* (
  env: Env,
  slug: string,
  visibility: Visibility,
  by: string,
) {
  if (visibility === 'public' && env.PUBLIC_PAGES !== 'on') return yield* refuse(422, 'public_pages_off')
  const changed = yield* setVisibility(env.DB, slug, visibility, by, yield* nowIso)
  const page = changed ? yield* pageOf(env.DB, slug) : Option.none()
  if (Option.isNone(page)) return yield* refuse(404, 'page_not_found')
  return viewOf(page.value)
})

const link = Effect.fn('crit.api.newLink')(function* (request: Request, env: Env, origin: string, slug: string) {
  // No body at all is a link with the site's own length.
  const text = yield* attempt(() => request.clone().text())
  const input = text.trim() === '' ? { days: undefined } : yield* bodyOf(request, decodeLink, 'invalid_link')
  return json(yield* makeLink(env, origin, slug, input.days), 201)
})

const keep = Effect.fn('crit.api.keep')(function* (request: Request, env: Env, slug: string) {
  const input = yield* bodyOf(request, decodeKeep, 'invalid_keep')
  const kept = yield* setKeep(env.DB, slug, input.keep, yield* afterDays(amountOf(env.EXPIRY_DAYS)))
  const page = kept ? yield* pageOf(env.DB, slug) : Option.none()
  if (Option.isNone(page)) return yield* refuse(404, 'page_not_found')
  return json({ page: viewOf(page.value) })
})

const remove = Effect.fn('crit.api.remove')(function* (env: Env, slug: string) {
  const removed = yield* removePage(env.DB, slug, yield* nowIso)
  if (!removed) return yield* refuse(404, 'page_not_found')
  return new Response(null, { status: 204, headers: guardHeaders })
})

const onLinks = Effect.fn('crit.api.links')(function* (
  request: Request,
  env: Env,
  origin: string,
  slug: string,
  id: string | undefined,
) {
  const { method } = request
  if (method === 'DELETE') return json(yield* revoke(env, slug, id))
  if (id === undefined && method === 'POST') return yield* link(request, env, origin, slug)
  if (id === undefined && method === 'GET') return json({ links: yield* linksOf(env.DB, slug) })
  return yield* refuse(405, 'method_not_allowed')
})

const onPage = Effect.fn('crit.api.page')(function* (request: Request, env: Env, slug: string, rest: string) {
  const { method } = request
  if (rest === '/visibility' && method === 'POST') {
    const input = yield* bodyOf(request, decodeVisibility, 'invalid_visibility')
    return json({ page: yield* changeVisibility(env, slug, input.visibility, 'agent') })
  }
  if (rest === '' && method === 'PATCH') return yield* keep(request, env, slug)
  if (rest === '' && method === 'DELETE') return yield* remove(env, slug)
  return yield* refuse(405, 'method_not_allowed')
})

export const api = Effect.fn('crit.api')(function* (request: Request, env: Env, url: URL) {
  yield* authorized(request, env)
  const { method } = request
  const path = url.pathname
  const comment = commentApi(request, env, url)
  if (comment !== undefined) return yield* comment
  if (method === 'POST' && path === '/api/publish/plan') return yield* plan(request, env)
  if (method === 'POST' && path === '/api/publish/commit') return yield* commit(request, env)
  if (method === 'POST' && path === '/api/sweep') return json(yield* sweep(env))
  const blob = /^\/api\/blobs\/([^/]+)$/u.exec(path)?.[1]
  if (method === 'PUT' && blob !== undefined) return yield* putBlob(request, env, blob)
  if (method === 'GET' && path === '/api/pages') {
    return json({ pages: (yield* listedPages(env.DB, true)).map(viewOf) })
  }
  const page = /^\/api\/pages\/([a-z0-9_][a-z0-9_-]{0,79})(\/visibility|\/links(?:\/([0-9a-f]{16}))?)?$/u.exec(path)
  const slug = page?.[1]
  if (slug === undefined) return yield* refuse(404, 'not_found')
  const rest = page?.[2] ?? ''
  if (rest.startsWith('/links')) return yield* onLinks(request, env, url.origin, slug, page?.[3])
  return yield* onPage(request, env, slug, rest)
})
