/**
 * The clean-up the Worker runs on its cron (and `POST /api/sweep` runs on demand):
 * 1. pages past their expiry are taken down, with their links and versions;
 * 2. versions beyond a page's last five go;
 * 3. files no version names any more are deleted from R2, once they have been unused for the grace period, so a
 *    publish between its plan and its commit never loses a file it was told is there.
 * Each run does a bounded amount, so it fits a Worker's limits; what is left waits for the next run.
 */
import { Effect, Schema } from 'effect'
import type { Env } from './Env.ts'
import { attempt, mustDecode } from './Http.ts'
import { KEPT_VERSIONS } from './Store.ts'
import { amountOf, hoursAgo, nowIso } from './Time.ts'

const BATCH = 500
const BATCHES_PER_RUN = 4

const ShaRow = Schema.Struct({ sha256: Schema.String })
const shaRows = mustDecode(Schema.decodeUnknownOption(Schema.Array(ShaRow)), 'blob row')

const EXPIRED = 'SELECT slug FROM pages WHERE removed_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?1'

const expirePages = (db: D1Database, now: string) =>
  attempt(() =>
    db.batch([
      db.prepare(`UPDATE links SET revoked_at = ?1 WHERE revoked_at IS NULL AND page IN (${EXPIRED})`).bind(now),
      db.prepare(`DELETE FROM versions WHERE page IN (${EXPIRED})`).bind(now),
      db
        .prepare(
          `UPDATE pages SET removed_at = ?1, updated_at = ?1
           WHERE removed_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?1`,
        )
        .bind(now),
      db
        .prepare(
          `DELETE FROM versions
           WHERE number <= (SELECT head_version FROM pages WHERE pages.slug = versions.page) - ?1`,
        )
        .bind(KEPT_VERSIONS),
    ]),
  ).pipe(Effect.map((results) => results[2]?.meta.changes ?? 0))

/** Files unused since `before` that no version's manifest names. */
const unusedBlobs = (db: D1Database, before: string) =>
  attempt(() =>
    db
      .prepare(
        `SELECT sha256 FROM blobs
         WHERE COALESCE(seen_at, created_at) <= ?1
           AND sha256 NOT IN (
             SELECT json_extract(file.value, '$.sha256') FROM versions, json_each(versions.manifest) AS file
           )
         LIMIT ?2`,
      )
      .bind(before, BATCH)
      .all(),
  ).pipe(
    Effect.flatMap((result) => shaRows(result.results)),
    Effect.map((rows) => rows.map((row) => row.sha256)),
  )

const dropBlobs = Effect.fn('crit.sweep.blobs')(function* (env: Env, before: string) {
  let dropped = 0
  for (let batch = 0; batch < BATCHES_PER_RUN; batch++) {
    const unused = yield* unusedBlobs(env.DB, before)
    if (unused.length === 0) break
    yield* attempt(() => env.BLOBS.delete(unused.map((sha) => `blobs/${sha}`)))
    yield* attempt(() =>
      env.DB.prepare('DELETE FROM blobs WHERE sha256 IN (SELECT value FROM json_each(?1))')
        .bind(JSON.stringify(unused))
        .run(),
    )
    dropped += unused.length
    if (unused.length < BATCH) break
  }
  return dropped
})

export const sweep = Effect.fn('crit.sweep')(function* (env: Env) {
  const expired = yield* expirePages(env.DB, yield* nowIso)
  const blobs = yield* dropBlobs(env, yield* hoursAgo(amountOf(env.BLOB_GRACE_HOURS, 24)))
  return { expired, blobs }
})
