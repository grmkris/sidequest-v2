/**
 * The D1 statements for pages over immutable versions, the blobs R2 holds, and share links (migrations/0001_init.sql,
 * 0003_hygiene.sql). Rows are decoded before use, so a schema drift fails loudly instead of serving something wrong.
 * A page or a link past its `expires_at` is gone for every reader at once; Sweep.ts tidies up after it.
 */
import { Effect, Option, Schema } from 'effect'
import { attempt, mustDecode } from './Http.ts'
import { type LinkView, Manifest, type PageView, Visibility } from './Model.ts'

const PageRow = Schema.Struct({
  slug: Schema.String,
  head_version: Schema.Int,
  title: Schema.String,
  description: Schema.String,
  date: Schema.String,
  tags: Schema.String,
  updated_at: Schema.String,
  links: Schema.Int,
  keep: Schema.Int,
  expires_at: Schema.NullOr(Schema.String),
  visibility: Visibility,
})
type PageRow = typeof PageRow.Type

const pageRows = mustDecode(Schema.decodeUnknownOption(Schema.Array(PageRow)), 'pages row')
const manifestText = mustDecode(Schema.decodeUnknownOption(Schema.fromJsonString(Manifest)), 'manifest')
const VersionRow = Schema.Struct({ page: Schema.String, number: Schema.Int, manifest: Schema.String })
const versionRows = mustDecode(Schema.decodeUnknownOption(Schema.Array(VersionRow)), 'versions row')
const valueRows = mustDecode(
  Schema.decodeUnknownOption(Schema.Array(Schema.Struct({ value: Schema.String }))),
  'value row',
)

/** The database's clock in the format the times are stored in, so `expires_at > NOW` compares as text. */
const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
const openLink = (alias: string) =>
  `${alias}.revoked_at IS NULL AND (${alias}.expires_at IS NULL OR ${alias}.expires_at > ${NOW})`
/** A page readers can have: not taken down, and not past its expiry. */
const LIVE = `p.removed_at IS NULL AND (p.expires_at IS NULL OR p.expires_at > ${NOW})`
const PAGE = `p.slug, p.head_version, p.title, p.description, p.date, p.tags, p.updated_at, p.keep, p.expires_at, p.visibility,
  (SELECT COUNT(*) FROM links l WHERE l.page = p.slug AND ${openLink('l')}) AS links`

export const viewOf = (row: PageRow): PageView => ({
  slug: row.slug,
  version: row.head_version,
  title: row.title,
  description: row.description,
  date: row.date,
  tags: row.tags === '' ? [] : row.tags.split(','),
  updatedAt: row.updated_at,
  visibility: row.visibility,
  links: row.links,
  keep: row.keep === 1,
  expiresAt: row.expires_at,
})

const first = <A>(rows: ReadonlyArray<A>): Option.Option<A> => Option.fromNullishOr(rows[0])

/** A live page (removed and expired pages are gone for every reader). */
export const pageOf = (db: D1Database, slug: string) =>
  attempt(() => db.prepare(`SELECT ${PAGE} FROM pages p WHERE p.slug = ?1 AND ${LIVE}`).bind(slug).all()).pipe(
    Effect.flatMap((result) => pageRows(result.results)),
    Effect.map(first),
  )

/** Live pages for the index and the `pages` command: newest date first. Names starting with `_` are not listed. */
export const listedPages = (db: D1Database, all: boolean) =>
  attempt(() =>
    db
      .prepare(
        `SELECT ${PAGE} FROM pages p WHERE ${LIVE} ${all ? '' : "AND p.slug NOT LIKE '\\_%' ESCAPE '\\'"}
         ORDER BY p.date DESC, p.title, p.slug LIMIT 1000`,
      )
      .all(),
  ).pipe(Effect.flatMap((result) => pageRows(result.results)))

/** A version's manifest never changes, so each isolate reads it once. */
const manifests = new Map<string, Manifest>()

export const manifestOf = (db: D1Database, slug: string, version: number) =>
  Effect.gen(function* () {
    const key = `${slug}@${version}`
    const cached = manifests.get(key)
    if (cached !== undefined) return Option.some(cached)
    const result = yield* attempt(() =>
      db
        .prepare('SELECT page, number, manifest FROM versions WHERE page = ?1 AND number = ?2')
        .bind(slug, version)
        .all(),
    )
    const row = first(yield* versionRows(result.results))
    if (Option.isNone(row)) return Option.none<Manifest>()
    const manifest = yield* manifestText(row.value.manifest)
    if (manifests.size > 200) manifests.clear()
    manifests.set(key, manifest)
    return Option.some(manifest)
  })

/** The version an idempotency key already made, if any. */
export const versionByKey = (db: D1Database, key: string) =>
  attempt(() =>
    db.prepare('SELECT page, number, manifest FROM versions WHERE idempotency_key = ?1').bind(key).all(),
  ).pipe(
    Effect.flatMap((result) => versionRows(result.results)),
    Effect.map(first),
  )

/**
 * Which of these hashes R2 does not hold yet: two statements, whatever the page's size. The ones it holds are marked
 * as seen now, so the clean-up leaves them alone while this publish is on its way to its commit.
 */
export const missingBlobs = (db: D1Database, hashes: ReadonlyArray<string>, now: string) => {
  const wanted = JSON.stringify([...new Set(hashes)])
  return attempt(() =>
    db.batch([
      db.prepare('UPDATE blobs SET seen_at = ?2 WHERE sha256 IN (SELECT value FROM json_each(?1))').bind(wanted, now),
      db.prepare('SELECT value FROM json_each(?1) WHERE value NOT IN (SELECT sha256 FROM blobs)').bind(wanted),
    ]),
  ).pipe(
    Effect.flatMap((results) => valueRows(results[1]?.results ?? [])),
    Effect.map((rows) => rows.map((row) => row.value)),
  )
}

/** `flagged` is what the file looks like it holds (Guards.ts), found once at upload; null for a clean file. */
export const recordBlob = (db: D1Database, sha256: string, size: number, now: string, flagged: string | null) =>
  attempt(() =>
    db
      .prepare('INSERT OR IGNORE INTO blobs (sha256, size, created_at, seen_at, flagged) VALUES (?1, ?2, ?3, ?3, ?4)')
      .bind(sha256, size, now, flagged)
      .run(),
  )

const FlaggedRow = Schema.Struct({ sha256: Schema.String, flagged: Schema.String })
const flaggedRows = mustDecode(Schema.decodeUnknownOption(Schema.Array(FlaggedRow)), 'flagged row')

/** The files among these hashes that look like they hold a secret, with what. */
export const flaggedBlobs = (db: D1Database, hashes: ReadonlyArray<string>) =>
  attempt(() =>
    db
      .prepare(
        `SELECT sha256, flagged FROM blobs
         WHERE flagged IS NOT NULL AND sha256 IN (SELECT value FROM json_each(?1))`,
      )
      .bind(JSON.stringify([...new Set(hashes)]))
      .all(),
  ).pipe(Effect.flatMap((result) => flaggedRows(result.results)))

export interface NewVersion {
  readonly slug: string
  readonly number: number
  readonly manifest: Manifest
  readonly title: string
  readonly description: string
  readonly date: string
  readonly tags: ReadonlyArray<string>
  readonly key: string
  readonly now: string
  /** When the page takes itself down unless it is kept; null for never. */
  readonly expiresAt: string | null
  /** The publish was told to go ahead although a file was flagged. */
  readonly allowedSecrets: boolean
  /** What the publish asked for; undefined keeps an old page as it is and makes a new one the team's. */
  readonly visibility: Visibility | undefined
}

/** How many versions of a page keep their files after a publish. */
export const KEPT_VERSIONS = 5

/**
 * One publish, atomically: the version, the page's head, and the versions that fall out of the last five. A version
 * number is unique per page, so of two publishes racing for it one fails with a UNIQUE error and is retried.
 */
export const writeVersion = (db: D1Database, version: NewVersion) =>
  attempt(() =>
    db.batch([
      db
        .prepare(
          `INSERT INTO versions (page, number, manifest, created_at, idempotency_key, allowed_secrets)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        )
        .bind(
          version.slug,
          version.number,
          JSON.stringify(version.manifest),
          version.now,
          version.key,
          version.allowedSecrets ? 1 : 0,
        ),
      db
        .prepare(
          `INSERT INTO pages (slug, head_version, title, description, date, tags, created_at, updated_at, removed_at,
             expires_at, visibility, visibility_by, visibility_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?9, ?6, ?6, NULL, ?7, COALESCE(?8, 'team'),
             CASE WHEN ?8 IS NULL THEN NULL ELSE 'agent' END, CASE WHEN ?8 IS NULL THEN NULL ELSE ?6 END)
           ON CONFLICT (slug) DO UPDATE SET head_version = ?2, title = ?3, description = ?4, date = ?5, tags = ?9,
             updated_at = ?6, removed_at = NULL, expires_at = CASE WHEN pages.keep = 1 THEN NULL ELSE ?7 END,
             visibility = COALESCE(?8, pages.visibility),
             visibility_by = CASE WHEN ?8 IS NULL THEN pages.visibility_by ELSE 'agent' END,
             visibility_at = CASE WHEN ?8 IS NULL THEN pages.visibility_at ELSE ?6 END`,
        )
        .bind(
          version.slug,
          version.number,
          version.title,
          version.description,
          version.date,
          version.now,
          version.expiresAt,
          version.visibility ?? null,
          version.tags.join(','),
        ),
      db
        .prepare('DELETE FROM versions WHERE page = ?1 AND number <= ?2')
        .bind(version.slug, version.number - KEPT_VERSIONS),
    ]),
  )

/**
 * Takes a page down: no reader sees it, its links stop working, its versions go, and the name goes back to the
 * team, so a page published under it later is never public by inheritance. Files are collected later.
 */
export const removePage = (db: D1Database, slug: string, now: string) =>
  attempt(() =>
    db.batch([
      db
        .prepare(
          `UPDATE pages SET removed_at = ?2, updated_at = ?2, visibility = 'team', visibility_by = NULL,
             visibility_at = NULL WHERE slug = ?1 AND removed_at IS NULL`,
        )
        .bind(slug, now),
      db.prepare('UPDATE links SET revoked_at = ?2 WHERE page = ?1 AND revoked_at IS NULL').bind(slug, now),
      db.prepare('DELETE FROM versions WHERE page = ?1').bind(slug),
    ]),
  ).pipe(Effect.map((results) => (results[0]?.meta.changes ?? 0) > 0))

export interface NewLink {
  readonly id: string
  readonly hash: string
  readonly slug: string
  readonly now: string
  readonly expiresAt: string | null
}

export const addLink = (db: D1Database, link: NewLink) =>
  attempt(() =>
    db
      .prepare('INSERT INTO links (id, hash, page, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(link.id, link.hash, link.slug, link.now, link.expiresAt)
      .run(),
  )

const LinkRow = Schema.Struct({
  id: Schema.String,
  created_at: Schema.String,
  expires_at: Schema.NullOr(Schema.String),
})
const linkRows = mustDecode(Schema.decodeUnknownOption(Schema.Array(LinkRow)), 'links row')

/** The links that open a page now, oldest first: their ids and times, never their tokens. */
export const linksOf = (db: D1Database, slug: string) =>
  attempt(() =>
    db
      .prepare(
        `SELECT l.id, l.created_at, l.expires_at FROM links l
         WHERE l.page = ?1 AND l.id IS NOT NULL AND ${openLink('l')} ORDER BY l.created_at, l.id`,
      )
      .bind(slug)
      .all(),
  ).pipe(
    Effect.flatMap((result) => linkRows(result.results)),
    Effect.map((rows) =>
      rows.map((row): LinkView => ({ id: row.id, createdAt: row.created_at, expiresAt: row.expires_at })),
    ),
  )

/** Opens a live page to anyone or closes it to the team; answers whether the page is there. */
export const setVisibility = (db: D1Database, slug: string, visibility: Visibility, by: string, now: string) =>
  attempt(() =>
    db
      .prepare(
        `UPDATE pages AS p SET visibility = ?2, visibility_by = ?3, visibility_at = ?4 WHERE p.slug = ?1 AND ${LIVE}`,
      )
      .bind(slug, visibility, by, now)
      .run(),
  ).pipe(Effect.map((result) => result.meta.changes > 0))

/** Keeps a page (it never expires) or lets it go again, at `expiresAt`. Answers whether the page is there. */
export const setKeep = (db: D1Database, slug: string, keep: boolean, expiresAt: string | null) =>
  attempt(() =>
    db
      .prepare(`UPDATE pages AS p SET keep = ?2, expires_at = ?3 WHERE p.slug = ?1 AND ${LIVE}`)
      .bind(slug, keep ? 1 : 0, keep ? null : expiresAt)
      .run(),
  ).pipe(Effect.map((result) => result.meta.changes > 0))

/** Revokes every link of a page; answers how many stopped working. */
export const revokeLinks = (db: D1Database, slug: string, now: string) =>
  attempt(() =>
    db.prepare('UPDATE links SET revoked_at = ?2 WHERE page = ?1 AND revoked_at IS NULL').bind(slug, now).run(),
  ).pipe(Effect.map((result) => result.meta.changes))

/** Revokes one link of a page by its id; answers how many stopped working (0 or 1). */
export const revokeLink = (db: D1Database, slug: string, id: string, now: string) =>
  attempt(() =>
    db
      .prepare('UPDATE links SET revoked_at = ?3 WHERE page = ?1 AND id = ?2 AND revoked_at IS NULL')
      .bind(slug, id, now)
      .run(),
  ).pipe(Effect.map((result) => result.meta.changes))

/** The live page a share link opens: the token's hash must be a link of exactly this page, not revoked or ended. */
export const sharedPage = (db: D1Database, hash: string, slug: string) =>
  attempt(() =>
    db
      .prepare(
        `SELECT ${PAGE} FROM pages p JOIN links k ON k.page = p.slug
         WHERE k.hash = ?1 AND ${openLink('k')} AND p.slug = ?2 AND ${LIVE}`,
      )
      .bind(hash, slug)
      .all(),
  ).pipe(
    Effect.flatMap((result) => pageRows(result.results)),
    Effect.map(first),
  )

const HeadRow = Schema.Struct({ head_version: Schema.Int })
const headRows = mustDecode(Schema.decodeUnknownOption(Schema.Array(HeadRow)), 'head row')

/** The last version number a name ever had, removed or not: numbers never repeat, so a cached manifest stays right. */
export const lastVersionOf = (db: D1Database, slug: string) =>
  attempt(() => db.prepare('SELECT head_version FROM pages WHERE slug = ?1').bind(slug).all()).pipe(
    Effect.flatMap((result) => headRows(result.results)),
    Effect.map((rows) => rows[0]?.head_version ?? 0),
  )
