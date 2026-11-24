/**
 * The comments contract the Worker, the page script (client/) and the scripts share. Nothing here talks to
 * Cloudflare.
 */
import { Schema } from 'effect'
import { Slug } from './Model.ts'

/**
 * Where a comment lives: the page's name, then the path inside it as the browser sends it (percent-encoded), without
 * a trailing slash or `index.html`. `spike`, `spike/notes`, `spike/sub/page.html`.
 */
export const PageId = Schema.String.check(
  Schema.isMaxLength(300),
  Schema.isPattern(/^[a-z0-9_][a-z0-9_-]{0,79}(?:\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9._~%-]+)*$/u),
)

/** The page's name: the first segment of a page id. */
export const slugOf = (page: string): string => page.split('/')[0] ?? ''

export const CommentId = Schema.String.check(Schema.isPattern(/^[0-9a-f-]{36}$/u))
export const CommentStatus = Schema.Literals(['open', 'resolved'])
export type CommentStatus = typeof CommentStatus.Type
export const AuthorKind = Schema.Literals(['member', 'guest', 'agent'])
const AuthorName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60))
const Body = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))

/** A guest's per-browser key (the `x-crit-key` header): it lets that browser delete its own comments, nothing more. */
export const GuestKey = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{16,64}$/u))
export const guestKeyHeader = 'x-crit-key'

export const NewComment = Schema.Struct({
  page: PageId,
  anchor: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  anchorText: Schema.String.check(Schema.isMaxLength(300)),
  parentId: Schema.NullOr(CommentId),
  body: Body,
  /** A guest's name; a member's comes from Cloudflare Access. */
  name: Schema.optionalKey(AuthorName),
})

export const StatusChange = Schema.Struct({ status: CommentStatus })

export const CommentView = Schema.Struct({
  id: CommentId,
  page: Schema.String,
  anchor: Schema.String,
  anchorText: Schema.String,
  author: Schema.String,
  authorKind: AuthorKind,
  body: Schema.String,
  createdAt: Schema.String,
  /** The comment this one answers; null for a thread's first comment. */
  parentId: Schema.NullOr(Schema.String),
  status: CommentStatus,
  statusBy: Schema.NullOr(Schema.String),
  statusAt: Schema.NullOr(Schema.String),
  /** Whether the reader wrote it, and so may delete it. */
  mine: Schema.Boolean,
})
export type CommentView = typeof CommentView.Type

/** What the reader may do on this page. Only members resolve: agents answer, people decide. */
export const Reader = Schema.Struct({
  kind: Schema.Literals(['member', 'guest']),
  name: Schema.NullOr(Schema.String),
  canComment: Schema.Boolean,
  canResolve: Schema.Boolean,
})
export type Reader = typeof Reader.Type

export const AgentReply = Schema.Struct({ body: Body, name: Schema.optionalKey(AuthorName) })

/** One thread as the agents' API gives it: where it is, its first comment and the replies in order. */
export const AgentThread = Schema.Struct({
  page: Schema.String,
  slug: Slug,
  pageTitle: Schema.String,
  /** The page was taken down; its comments stay. */
  removed: Schema.Boolean,
  root: CommentView,
  replies: Schema.Array(CommentView),
})
export type AgentThread = typeof AgentThread.Type
export const ThreadsResponse = Schema.Struct({ threads: Schema.Array(AgentThread) })

/** How many comments one share link takes from guests in ten minutes. */
export const guestPostsPerWindow = 20
export const guestWindowMinutes = 10
export const guestMayPost = (postsInWindow: number): boolean => postsInWindow < guestPostsPerWindow
