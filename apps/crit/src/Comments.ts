/**
 * Comments as the page script (client/comments.ts) uses them, under the page's own address (`…/_crit/comments`):
 * - the team's, at `/<slug>/_crit/comments`: the reader is the person Cloudflare Access admitted. Members comment,
 *   resolve and reopen any thread, and delete only what they wrote.
 * - a visitor's, at `/p/<slug>/_crit/comments` (a public page) or `/s/<token>/<slug>/_crit/comments` (a share link):
 *   the `OUTSIDERS` binding says whether they see nothing of the threads (`none`), only read (`view`) or also write
 *   (`comment`). A guest types a name, is marked as a guest, never resolves, and deletes only what the same browser
 *   wrote (its key travels in `x-crit-key`, stored hashed).
 *
 * | Route (after the base)   | Result                                                          |
 * | ------------------------ | --------------------------------------------------------------- |
 * | `GET ?page=<page id>`    | `{ reader, comments }`, the page's comments oldest first        |
 * | `POST`                   | `{ page, anchor, anchorText, parentId, body, name? }` → 201     |
 * | `PATCH /<id>`            | `{ status }` on a thread's first comment, members only          |
 * | `DELETE /<id>`           | the reader's own comment, when nobody answered it → 204         |
 */
import { DateTime, Effect, Option, Schema } from 'effect'
import {
  CommentId,
  guestKeyHeader,
  GuestKey,
  guestMayPost,
  guestWindowMinutes,
  NewComment,
  PageId,
  type Reader,
  slugOf,
  StatusChange,
} from './CommentModel.ts'
import {
  addComment,
  commentOf,
  type CommentRow,
  commentsOn,
  commentView,
  dropComment,
  guestPostsSince,
  markStatus,
} from './CommentStore.ts'
import { randomId, sha256Hex } from './Crypto.ts'
import type { Env } from './Env.ts'
import { attempt, bodyOf, guardHeaders, json, refuse } from './Http.ts'
import { resolve } from './Files.ts'
import { manifestOf, pageOf, viewOf } from './Store.ts'

/** Who is asking: a member Cloudflare Access admitted, or a guest on one page (by its share link, or because it is public). */
export type Who =
  | { readonly kind: 'member'; readonly slug: string; readonly name: string; readonly keyHash: string }
  | {
      readonly kind: 'guest'
      readonly slug: string
      readonly linkHash: string
      readonly keyHash: string | undefined
      readonly mayRead: boolean
      readonly mayComment: boolean
    }

const decodeNew = Schema.decodeUnknownOption(NewComment)
const decodeStatus = Schema.decodeUnknownOption(StatusChange)
const decodeNames = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)))
const nowIso = Effect.map(DateTime.now, DateTime.formatIso)

/** Hashes that say who may delete a comment: never the email or the browser's key itself. */
const authorKey = (kind: 'member' | 'guest', secret: string) =>
  attempt(() => sha256Hex(`crit-author:${kind}:${secret}`))

/** A member's name for an email Access admitted: the config's name for it, else the email. */
export const nameOf = (env: Env, email: string): string =>
  Option.getOrElse(decodeNames(env.NAMES ?? '{}'), (): Readonly<Record<string, string>> => ({}))[email] ?? email

/** The member Access admitted (Access.ts checked the token): their email, shown through the config's names. */
export const memberOf = Effect.fn('crit.comments.member')(function* (env: Env, email: string, slug: string) {
  const who: Who = { kind: 'member', slug, name: nameOf(env, email), keyHash: yield* authorKey('member', email) }
  return who
})

/**
 * The guest on `slug`; their browser's key is optional until they write. `linkHash` is the share link's hash, or
 * `public:<slug>` on a public page, and is what the rate limit counts by.
 */
export const guestOf = Effect.fn('crit.comments.guest')(function* (
  request: Request,
  env: Env,
  slug: string,
  linkHash: string,
) {
  const key = request.headers.get(guestKeyHeader)
  const keyHash = key !== null && Schema.is(GuestKey)(key) ? yield* authorKey('guest', key) : undefined
  const who: Who = {
    kind: 'guest',
    slug,
    linkHash,
    keyHash,
    mayRead: env.OUTSIDERS === 'view' || env.OUTSIDERS === 'comment',
    mayComment: env.OUTSIDERS === 'comment',
  }
  return who
})

const readerOf = (who: Who): Reader =>
  who.kind === 'member'
    ? { kind: 'member', name: who.name, canComment: true, canResolve: true }
    : { kind: 'guest', name: null, canComment: who.mayComment, canResolve: false }

/** Comments are asked for under one page's address: every other page's are "not found" there. */
const within = (who: Who, slug: string) => (who.slug === slug ? Effect.void : refuse(404, 'not_found'))

const list = Effect.fn('crit.comments.list')(function* (env: Env, who: Who, url: URL) {
  const page = url.searchParams.get('page') ?? ''
  if (!Schema.is(PageId)(page)) return yield* refuse(400, 'page_required')
  yield* within(who, slugOf(page))
  // A site whose visitors see no threads (`outsiders: 'none'`) answers a guest with an empty page of them.
  const rows = who.kind === 'guest' && !who.mayRead ? [] : yield* commentsOn(env.DB, page)
  return json({ reader: readerOf(who), comments: rows.map((row) => commentView(row, who.keyHash)) })
})

/** What a guest must have before writing: leave to comment, a name, a browser key, and room under the rate limit. */
const guestWrites = Effect.fn('crit.comments.guestWrites')(function* (
  env: Env,
  who: Extract<Who, { kind: 'guest' }>,
  name: string | undefined,
) {
  if (!who.mayComment) return yield* refuse(403, 'comments_are_off')
  if (name === undefined || name.trim() === '') return yield* refuse(400, 'name_required')
  if (who.keyHash === undefined) return yield* refuse(400, 'key_required')
  const since = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { minutes: guestWindowMinutes }))
  if (!guestMayPost(yield* guestPostsSince(env.DB, who.linkHash, since))) return yield* refuse(429, 'slow_down')
  return { author: name.trim(), keyHash: who.keyHash, linkHash: who.linkHash }
})

const pathInside = (encoded: string): string | undefined => {
  try {
    return decodeURIComponent(encoded)
  } catch {
    return undefined
  }
}

/** A page id must name a file the page has now: its index, a folder's index, or a file such as `sub/page.html`. */
const pageExists = Effect.fn('crit.comments.pageExists')(function* (env: Env, id: string) {
  const slug = slugOf(id)
  const page = yield* pageOf(env.DB, slug)
  if (Option.isNone(page)) return false
  const manifest = yield* manifestOf(env.DB, slug, viewOf(page.value).version)
  const inside = pathInside(id.slice(slug.length + 1))
  if (Option.isNone(manifest) || inside === undefined) return false
  return [inside, `${inside}/`].some((path) => resolve(manifest.value, path).kind === 'file')
})

const create = Effect.fn('crit.comments.create')(function* (request: Request, env: Env, who: Who) {
  const input = yield* bodyOf(request, decodeNew, 'invalid_comment')
  const slug = slugOf(input.page)
  yield* within(who, slug)
  if (!(yield* pageExists(env, input.page))) return yield* refuse(404, 'page_not_found')
  const by =
    who.kind === 'member'
      ? { author: who.name, keyHash: who.keyHash, linkHash: null }
      : yield* guestWrites(env, who, input.name)
  // A reply joins its parent's thread: the same page, and the thread's anchor.
  const parent = input.parentId === null ? Option.none<CommentRow>() : yield* commentOf(env.DB, input.parentId)
  if (input.parentId !== null && (Option.isNone(parent) || parent.value.page !== input.page)) {
    return yield* refuse(400, 'parent_not_on_page')
  }
  const row: CommentRow = {
    id: randomId(),
    page: input.page,
    slug,
    anchor: Option.match(parent, { onNone: () => input.anchor, onSome: (found) => found.anchor }),
    anchor_text: Option.match(parent, { onNone: () => input.anchorText, onSome: (found) => found.anchor_text }),
    author: by.author,
    author_kind: who.kind,
    author_key_hash: by.keyHash,
    body: input.body,
    created_at: yield* nowIso,
    parent_id: input.parentId,
    status: 'open',
    status_by: null,
    status_at: null,
    link_hash: by.linkHash,
  }
  yield* addComment(env.DB, row)
  return json(commentView(row, who.keyHash), 201)
})

const setStatus = Effect.fn('crit.comments.status')(function* (request: Request, env: Env, who: Who, id: string) {
  if (who.kind !== 'member') return yield* refuse(403, 'only_the_team_resolves')
  const input = yield* bodyOf(request, decodeStatus, 'invalid_status')
  const found = yield* commentOf(env.DB, id)
  if (Option.isNone(found)) return yield* refuse(404, 'not_found')
  if (found.value.parent_id !== null) return yield* refuse(400, 'status_is_a_threads')
  const open = input.status === 'open'
  const by = open ? null : who.name
  const at = open ? null : yield* nowIso
  yield* markStatus(env.DB, id, input.status, by, at)
  return json(commentView({ ...found.value, status: input.status, status_by: by, status_at: at }, who.keyHash))
})

const remove = Effect.fn('crit.comments.remove')(function* (env: Env, who: Who, id: string) {
  const found = yield* commentOf(env.DB, id)
  if (Option.isNone(found)) return yield* refuse(404, 'not_found')
  yield* within(who, found.value.slug)
  if (who.keyHash === undefined || found.value.author_key_hash !== who.keyHash) return yield* refuse(403, 'not_yours')
  if (!(yield* dropComment(env.DB, id, who.keyHash))) return yield* refuse(409, 'has_replies')
  return new Response(null, { status: 204, headers: guardHeaders })
})

/** A page's reserved path for its comments (`_crit/comments`, `_crit/comments/<id>`): what follows the base. */
export const commentsRest = (path: string | undefined): string | undefined => {
  if (path === '_crit/comments') return ''
  return path?.startsWith('_crit/comments/') === true ? path.slice('_crit/comments'.length) : undefined
}

/**
 * A write must come from the page itself. A member's Access session is ambient, so another site could otherwise post
 * in their name: writes need a JSON body and, when the browser says where the request came from, the same origin.
 */
const sameSite = (request: Request, url: URL) => {
  const site = request.headers.get('sec-fetch-site')
  const origin = request.headers.get('origin')
  const typed = (request.headers.get('content-type') ?? '').includes('application/json')
  const foreign =
    (site !== null && site !== 'same-origin' && site !== 'none') || (origin !== null && origin !== url.origin)
  return foreign || (request.method !== 'DELETE' && !typed) ? refuse(403, 'cross_site') : Effect.void
}

/** `rest` is the path after the comments base: `` for the collection, `/<id>` for one comment. */
export const comments = Effect.fn('crit.comments')(function* (
  request: Request,
  env: Env,
  who: Who,
  url: URL,
  rest: string,
) {
  const { method } = request
  if (method !== 'GET') yield* sameSite(request, url)
  if (rest === '') {
    if (method === 'GET') return yield* list(env, who, url)
    if (method === 'POST') return yield* create(request, env, who)
    return yield* refuse(405, 'method_not_allowed')
  }
  const id = rest.slice(1)
  if (!rest.startsWith('/') || !Schema.is(CommentId)(id)) return yield* refuse(404, 'not_found')
  if (method === 'PATCH') return yield* setStatus(request, env, who, id)
  if (method === 'DELETE') return yield* remove(env, who, id)
  return yield* refuse(405, 'method_not_allowed')
})
