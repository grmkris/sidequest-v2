/**
 * Comments for agents, behind the bearer token (Api.ts authorizes before calling here).
 *
 * | Route                                   | Result                                                            |
 * | --------------------------------------- | ----------------------------------------------------------------- |
 * | `GET /api/comments?page=&status=&since=`| `{ threads }`; Markdown with `Accept: text/markdown`              |
 * | `GET /api/comments.md?…`                | the same as Markdown                                              |
 * | `POST /api/comments/<id>/replies`       | `{ body, name? }` → 201, a reply written as an agent              |
 *
 * `page` is a page's name or a page id inside it; `status` is `open` (the default), `resolved` or `all`; `since` keeps
 * threads with anything written or resolved at or after that ISO time. Agents answer; they cannot resolve.
 */
import { DateTime, Effect, Option, Schema } from 'effect'
import { type AgentThread, AgentReply, CommentId, PageId, slugOf } from './CommentModel.ts'
import { threadsMarkdown } from './CommentMarkdown.ts'
import { addComment, type AgentRow, commentOf, type CommentRow, commentsFor, commentView } from './CommentStore.ts'
import { randomId } from './Crypto.ts'
import { type Env, hasTeam } from './Env.ts'
import { bodyOf, guardHeaders, json, refuse } from './Http.ts'
import { threadsOf } from './Threads.ts'

const decodeReply = Schema.decodeUnknownOption(AgentReply)
const Status = Schema.Literals(['open', 'resolved', 'all'])

export interface ThreadFilter {
  readonly page: string | undefined
  readonly status: typeof Status.Type
  readonly since: string | undefined
}

/** Rows (one name's or everyone's) into threads, filtered: by page id, by status, and by anything new since a time. */
export const agentThreads = (rows: ReadonlyArray<AgentRow>, filter: ThreadFilter): ReadonlyArray<AgentThread> => {
  const about = new Map(rows.map((row) => [row.page, row]))
  const views = rows.map((row) => commentView(row, undefined))
  return threadsOf(views).flatMap(({ root, replies }) => {
    const row = about.get(root.page)
    if (row === undefined) return []
    if (filter.page !== undefined && filter.page.includes('/') && root.page !== filter.page) return []
    if (filter.status !== 'all' && root.status !== filter.status) return []
    const touched = [root.createdAt, root.statusAt ?? '', ...replies.map((reply) => reply.createdAt)]
    if (filter.since !== undefined && !touched.some((at) => at >= (filter.since ?? ''))) return []
    return [
      {
        page: root.page,
        slug: row.slug,
        pageTitle: row.page_title ?? '',
        removed: row.page_removed === 1,
        root,
        replies,
      },
    ]
  })
}

/** A filter from what the caller gave: a page or page id, a status (open when absent) and an ISO time. */
export const filterFrom = (asked: {
  readonly page?: string | undefined
  readonly status?: string | undefined
  readonly since?: string | undefined
}) =>
  Effect.gen(function* () {
    const { page } = asked
    if (page !== undefined && !Schema.is(PageId)(page)) return yield* refuse(400, 'invalid_page')
    const status = asked.status ?? 'open'
    if (!Schema.is(Status)(status)) return yield* refuse(400, 'invalid_status')
    const given = asked.since
    const since = given === undefined ? undefined : DateTime.make(given)
    if (since !== undefined && Option.isNone(since)) return yield* refuse(400, 'invalid_since')
    const filter: ThreadFilter = {
      page,
      status,
      since: since === undefined ? undefined : Option.getOrUndefined(Option.map(since, DateTime.formatIso)),
    }
    return filter
  })

/** The threads an agent asked for. */
export const threadsFor = Effect.fn('crit.comments.agentThreads')(function* (env: Env, filter: ThreadFilter) {
  const rows = yield* commentsFor(env.DB, filter.page === undefined ? undefined : slugOf(filter.page))
  return agentThreads(rows, filter)
})

/** Threads as the Markdown agents read, with links to the pages where the team opens them, when the site has a team side. */
export const markdownOf = (env: Env, origin: string, threads: ReadonlyArray<AgentThread>): string =>
  threadsMarkdown(threads, hasTeam(env) ? origin : undefined)

const list = Effect.fn('crit.comments.agentList')(function* (request: Request, env: Env, url: URL, markdown: boolean) {
  const threads = yield* threadsFor(env, yield* filterOf(url))
  if (!markdown && !(request.headers.get('accept') ?? '').includes('text/markdown')) return json({ threads })
  return new Response(markdownOf(env, url.origin, threads), {
    headers: { ...guardHeaders, 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' },
  })
})

const filterOf = (url: URL) =>
  filterFrom({
    page: url.searchParams.get('page') ?? undefined,
    status: url.searchParams.get('status') ?? undefined,
    since: url.searchParams.get('since') ?? undefined,
  })

/** An agent's answer on a thread. Agents answer; people resolve. */
export const replyAs = Effect.fn('crit.comments.agentReply')(function* (
  env: Env,
  id: string,
  input: typeof AgentReply.Type,
) {
  if (!Schema.is(CommentId)(id)) return yield* refuse(404, 'thread_not_found')
  const parent = yield* commentOf(env.DB, id)
  if (Option.isNone(parent)) return yield* refuse(404, 'thread_not_found')
  const row: CommentRow = {
    id: randomId(),
    page: parent.value.page,
    slug: parent.value.slug,
    anchor: parent.value.anchor,
    anchor_text: parent.value.anchor_text,
    author: input.name?.trim() || 'agent',
    author_kind: 'agent',
    author_key_hash: null,
    body: input.body,
    created_at: DateTime.formatIso(yield* DateTime.now),
    parent_id: parent.value.id,
    status: 'open',
    status_by: null,
    status_at: null,
    link_hash: null,
  }
  yield* addComment(env.DB, row)
  return commentView(row, undefined)
})

const reply = Effect.fn('crit.comments.agentReplyRoute')(function* (request: Request, env: Env, id: string) {
  return json(yield* replyAs(env, id, yield* bodyOf(request, decodeReply, 'invalid_reply')), 201)
})

/** The comment routes of the agents' API, or undefined when the path is not one of them. */
export const commentApi = (request: Request, env: Env, url: URL) => {
  const { method } = request
  const path = url.pathname
  if (path === '/api/comments' || path === '/api/comments.md') {
    return method === 'GET' ? list(request, env, url, path.endsWith('.md')) : refuse(405, 'method_not_allowed')
  }
  const thread = /^\/api\/comments\/([^/]+)\/replies$/u.exec(path)?.[1]
  if (thread === undefined) return undefined
  if (!Schema.is(CommentId)(thread)) return refuse(404, 'thread_not_found')
  return method === 'POST' ? reply(request, env, thread) : refuse(405, 'method_not_allowed')
}
