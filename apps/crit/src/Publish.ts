/**
 * Publishing is three calls and no deploy:
 * 1. `plan` names the files R2 does not hold yet,
 * 2. `PUT /api/blobs/<sha256>` uploads each, and R2 itself refuses a body that does not match the hash,
 * 3. `commit` writes one version and moves the page's head, safe to retry under its `Idempotency-Key`.
 * A page is never half-published, and two agents publishing one page never mix their files.
 *
 * The guards (Guards.ts) hold here whatever the caller did: a text file is read for secrets once, at upload, and what
 * it looks like it holds is kept with the file; a commit refuses a denied path, and refuses a flagged file unless the
 * publish says `allowSecrets`, which the version then records.
 */
import { Effect, Option, Schema } from 'effect'
import type { Env } from './Env.ts'
import { deniedPath, flagsOf, scanBytes } from './Guards.ts'
import { attempt, bodyOf, json, type Refused, refuse, Unavailable } from './Http.ts'
import { metaFrom } from './Meta.ts'
import {
  IdempotencyKey,
  idempotencyHeader,
  type Manifest,
  maxFileBytes,
  maxPageBytes,
  type PageView,
  PublishRequest,
  reservedSlugs,
  Sha256,
} from './Model.ts'
import {
  flaggedBlobs,
  lastVersionOf,
  missingBlobs,
  pageOf,
  recordBlob,
  versionByKey,
  viewOf,
  writeVersion,
} from './Store.ts'
import { afterDays, amountOf, nowIso } from './Time.ts'

const decodeRequest = Schema.decodeUnknownOption(PublishRequest)

/**
 * What a publish must be before anything else is looked at: a name that is not one of crit's own addresses, no
 * repeated path, no denied path, within the size.
 */
const checked = (page: string, manifest: Manifest) => {
  if (reservedSlugs.includes(page)) return refuse(422, 'reserved_name', reservedSlugs.join(', '))
  const paths = new Set(manifest.map((entry) => entry.path))
  if (paths.size !== manifest.length) return refuse(400, 'duplicate_path')
  const denied = manifest.filter((entry) => deniedPath(entry.path)).map((entry) => entry.path)
  if (denied.length > 0) return refuse(422, 'denied_path', denied.slice(0, 20).join(', '))
  const total = manifest.reduce((sum, entry) => sum + entry.size, 0)
  return total > maxPageBytes ? refuse(413, 'page_too_large') : Effect.void
}

export const plan = Effect.fn('crit.publish.plan')(function* (request: Request, env: Env) {
  const body = yield* bodyOf(request, decodeRequest, 'invalid_manifest')
  yield* checked(body.page, body.manifest)
  const hashes = body.manifest.map((entry) => entry.sha256)
  return json({ missing: yield* missingBlobs(env.DB, hashes, yield* nowIso) })
})

/** R2 compares the body with the hash we name and rejects a mismatch, so a stored blob always is what its key says. */
const store = (env: Env, sha: string, body: ReadableStream | Uint8Array<ArrayBuffer>) =>
  Effect.tryPromise({
    try: () => env.BLOBS.put(`blobs/${sha}`, body, { sha256: sha }),
    catch: (cause) => new Unavailable({ cause }),
  }).pipe(
    Effect.catchTag('Unavailable', (failure): Effect.Effect<never, Refused | Unavailable> =>
      /sha-?256|checksum|digest|hash/iu.test(String(failure.cause))
        ? refuse(400, 'hash_mismatch')
        : Effect.fail(failure),
    ),
  )

/** Stores a file already in memory: read for secrets, then kept under its hash. */
export const storeBytes = Effect.fn('crit.publish.bytes')(function* (
  env: Env,
  sha: string,
  bytes: Uint8Array<ArrayBuffer>,
) {
  const flags = flagsOf(bytes)
  const object = yield* store(env, sha, bytes)
  yield* recordBlob(env.DB, sha, object.size, yield* nowIso, flags.length === 0 ? null : flags.join(', '))
})

export const putBlob = Effect.fn('crit.publish.blob')(function* (request: Request, env: Env, sha: string) {
  if (!Schema.is(Sha256)(sha)) return yield* refuse(400, 'invalid_sha256')
  const length = Number(request.headers.get('content-length') ?? Number.NaN)
  if (!Number.isInteger(length) || length < 0) return yield* refuse(411, 'length_required')
  if (length > maxFileBytes) return yield* refuse(413, 'file_too_large')
  if (length <= scanBytes) {
    // Small enough to hold: it is read once for secrets on its way to R2.
    yield* storeBytes(env, sha, new Uint8Array(yield* attempt(() => request.arrayBuffer())))
  } else {
    // A large file (a film, an archive) is streamed and not read.
    const object = yield* store(env, sha, request.body ?? new Blob([]).stream())
    yield* recordBlob(env.DB, sha, object.size, yield* nowIso, null)
  }
  return json({ stored: sha }, 201)
})

/** The index's line for a page, from the first part of its `index.html` (a page without one is listed by its name). */
const metaOf = Effect.fn('crit.publish.meta')(function* (env: Env, slug: string, manifest: Manifest) {
  const index = manifest.find((entry) => entry.path === 'index.html')
  if (index === undefined) return metaFrom('', slug)
  const object = yield* attempt(() =>
    env.BLOBS.get(`blobs/${index.sha256}`, { range: { offset: 0, length: Math.min(index.size, 262_144) } }),
  )
  return metaFrom(object === null ? '' : yield* attempt(() => object.text()), slug)
})

/** Refuses a manifest with files that looked like they hold a secret when they were uploaded. */
const unflagged = Effect.fn('crit.publish.guards')(function* (env: Env, manifest: Manifest) {
  const flagged = new Map(
    (yield* flaggedBlobs(
      env.DB,
      manifest.map((entry) => entry.sha256),
    )).map((row) => [row.sha256, row.flagged]),
  )
  const found = manifest.flatMap((entry) => {
    const flags = flagged.get(entry.sha256)
    return flags === undefined ? [] : [`${entry.path}: ${flags}`]
  })
  if (found.length > 0) return yield* refuse(422, 'secrets_found', found.slice(0, 20).join('; '))
})

interface Committed {
  readonly page: PageView
  readonly replayed: boolean
}

const replayOf = Effect.fn('crit.publish.replay')(function* (env: Env, slug: string, key: string) {
  const made = yield* versionByKey(env.DB, key)
  if (Option.isNone(made)) return Option.none<Committed>()
  const page = made.value.page === slug ? yield* pageOf(env.DB, slug) : Option.none()
  if (Option.isNone(page)) return yield* refuse(409, 'idempotency_key_reused')
  return Option.some<Committed>({ page: viewOf(page.value), replayed: true })
})

/** One version of a page from files R2 already holds. The HTTP commit and the MCP `page_publish` both end here. */
export const commitVersion = Effect.fn('crit.publish.version')(function* (
  env: Env,
  input: typeof PublishRequest.Type,
  key: string,
) {
  yield* checked(input.page, input.manifest)
  if (input.visibility === 'public' && env.PUBLIC_PAGES !== 'on') return yield* refuse(422, 'public_pages_off')
  const replay = yield* replayOf(env, input.page, key)
  if (Option.isSome(replay)) return replay.value
  const now = yield* nowIso
  const hashes = input.manifest.map((entry) => entry.sha256)
  const missing = yield* missingBlobs(env.DB, hashes, now)
  if (missing.length > 0) return yield* refuse(409, 'blobs_missing', missing.slice(0, 20).join(','))
  const allowSecrets = input.allowSecrets === true
  if (!allowSecrets) yield* unflagged(env, input.manifest)
  const meta = yield* metaOf(env, input.page, input.manifest)
  const number = (yield* lastVersionOf(env.DB, input.page)) + 1
  yield* writeVersion(env.DB, {
    slug: input.page,
    number,
    manifest: input.manifest,
    ...meta,
    key,
    now,
    expiresAt: yield* afterDays(amountOf(env.EXPIRY_DAYS)),
    allowedSecrets: allowSecrets,
    visibility: input.visibility,
  }).pipe(
    // Another publish took this version number a moment ago: the caller retries with the same key.
    Effect.catchTag('Unavailable', (failure): Effect.Effect<never, Refused | Unavailable> =>
      /UNIQUE/u.test(String(failure.cause)) ? refuse(409, 'concurrent_publish') : Effect.fail(failure),
    ),
  )
  const page = yield* pageOf(env.DB, input.page)
  if (Option.isNone(page)) return yield* refuse(409, 'concurrent_publish')
  const made: Committed = { page: viewOf(page.value), replayed: false }
  return made
})

export const commit = Effect.fn('crit.publish.commit')(function* (request: Request, env: Env) {
  const key = request.headers.get(idempotencyHeader) ?? ''
  if (!Schema.is(IdempotencyKey)(key)) return yield* refuse(400, 'missing_idempotency_key')
  const body = yield* bodyOf(request, decodeRequest, 'invalid_manifest')
  const made = yield* commitVersion(env, body, key)
  return json(made, made.replayed ? 200 : 201)
})
