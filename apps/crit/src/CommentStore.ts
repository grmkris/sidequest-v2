/** Every D1 statement for comments (migrations/0002_comments.sql). Rows are decoded before use. */
import { Effect, Option, Schema } from 'effect'
import { AuthorKind, CommentStatus, type CommentView } from './CommentModel.ts'
import { attempt, mustDecode } from './Http.ts'

const CommentRow = Schema.Struct({
  id: Schema.String,
  page: Schema.String,
  slug: Schema.String,
  anchor: Schema.String,
  anchor_text: Schema.String,
  author: Schema.String,
  author_kind: AuthorKind,
  author_key_hash: Schema.NullOr(Schema.String),
  body: Schema.String,
  created_at: Schema.String,
  parent_id: Schema.NullOr(Schema.String),
  status: CommentStatus,
  status_by: Schema.NullOr(Schema.String),
  status_at: Schema.NullOr(Schema.String),
  link_hash: Schema.NullOr(Schema.String),
})
export type CommentRow = typeof CommentRow.Type

const commentRows = mustDecode(Schema.decodeUnknownOption(Schema.Array(CommentRow)), 'comments row')
const countRows = mustDecode(
  Schema.decodeUnknownOption(Schema.Array(Schema.Struct({ posts: Schema.Int }))),
  'count row',
)

const COLUMNS = `id, page, slug, anchor, anchor_text, author, author_kind, author_key_hash, body, created_at, parent_id,
  status, status_by, status_at, link_hash`
const C_COLUMNS = COLUMNS.replaceAll(/(\w+)/gu, 'c.$1')

/** A comment as readers get it. `keyHash` is the reader's own: a comment written under it is theirs to delete. */
export const commentView = (row: CommentRow, keyHash: string | undefined): CommentView => ({
  id: row.id,
  page: row.page,
  anchor: row.anchor,
  anchorText: row.anchor_text,
  author: row.author,
  authorKind: row.author_kind,
  body: row.body,
  createdAt: row.created_at,
  parentId: row.parent_id,
  status: row.status,
  statusBy: row.status_by,
  statusAt: row.status_at,
  mine: keyHash !== undefined && row.author_key_hash === keyHash,
})

/** One page's comments, oldest first. */
export const commentsOn = (db: D1Database, page: string) =>
  attempt(() =>
    db.prepare(`SELECT ${COLUMNS} FROM comments WHERE page = ?1 ORDER BY created_at, id LIMIT 2000`).bind(page).all(),
  ).pipe(Effect.flatMap((result) => commentRows(result.results)))

export const commentOf = (db: D1Database, id: string) =>
  attempt(() => db.prepare(`SELECT ${COLUMNS} FROM comments WHERE id = ?1`).bind(id).all()).pipe(
    Effect.flatMap((result) => commentRows(result.results)),
    Effect.map((rows) => Option.fromNullishOr(rows[0])),
  )

export const addComment = (db: D1Database, row: CommentRow) =>
  attempt(() =>
    db
      .prepare(
        `INSERT INTO comments (${COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
      )
      .bind(
        row.id,
        row.page,
        row.slug,
        row.anchor,
        row.anchor_text,
        row.author,
        row.author_kind,
        row.author_key_hash,
        row.body,
        row.created_at,
        row.parent_id,
        row.status,
        row.status_by,
        row.status_at,
        row.link_hash,
      )
      .run(),
  )

export const markStatus = (db: D1Database, id: string, status: CommentStatus, by: string | null, at: string | null) =>
  attempt(() =>
    db
      .prepare('UPDATE comments SET status = ?2, status_by = ?3, status_at = ?4 WHERE id = ?1')
      .bind(id, status, by, at)
      .run(),
  )

/**
 * Deletes one comment its author wrote, unless someone answered it: other people's words are never deleted with it.
 * Answers whether a row went.
 */
export const dropComment = (db: D1Database, id: string, keyHash: string) =>
  attempt(() =>
    db
      .prepare(
        `DELETE FROM comments WHERE id = ?1 AND author_key_hash = ?2
         AND NOT EXISTS (SELECT 1 FROM comments r WHERE r.parent_id = ?1)`,
      )
      .bind(id, keyHash)
      .run(),
  ).pipe(Effect.map((result) => result.meta.changes > 0))

/** How many comments guests posted through one share link since `since`. */
export const guestPostsSince = (db: D1Database, linkHash: string, since: string) =>
  attempt(() =>
    db
      .prepare('SELECT COUNT(*) AS posts FROM comments WHERE link_hash = ?1 AND created_at >= ?2')
      .bind(linkHash, since)
      .all(),
  ).pipe(
    Effect.flatMap((result) => countRows(result.results)),
    Effect.map((rows) => rows[0]?.posts ?? 0),
  )

const AgentRow = Schema.Struct({
  ...CommentRow.fields,
  page_title: Schema.NullOr(Schema.String),
  page_removed: Schema.Int,
})
export type AgentRow = typeof AgentRow.Type
const agentRows = mustDecode(Schema.decodeUnknownOption(Schema.Array(AgentRow)), 'agent comments row')

/**
 * Comments for the agents' API: every page's, or one name's, with the page's title and whether it was taken down
 * (a removed page keeps its comments).
 */
export const commentsFor = (db: D1Database, slug: string | undefined) =>
  attempt(() =>
    db
      .prepare(
        `SELECT ${C_COLUMNS}, p.title AS page_title,
           CASE WHEN p.slug IS NULL OR p.removed_at IS NOT NULL THEN 1 ELSE 0 END AS page_removed
         FROM comments c LEFT JOIN pages p ON p.slug = c.slug
         WHERE ?1 IS NULL OR c.slug = ?1
         ORDER BY c.slug, c.page, c.created_at, c.id LIMIT 5000`,
      )
      .bind(slug ?? null)
      .all(),
  ).pipe(Effect.flatMap((result) => agentRows(result.results)))
