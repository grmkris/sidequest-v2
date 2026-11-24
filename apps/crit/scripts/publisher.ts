/** Hash, plan, upload what is missing six at a time, commit. A commit lost to a racing publish is retried. */
import { Schema } from 'effect'
import { randomToken, sha256Hex } from '../src/Crypto.ts'
import {
  CommitResponse,
  idempotencyHeader,
  type Manifest,
  type PageView,
  PlanResponse,
  type Visibility,
} from '../src/Model.ts'
import { ApiError, call, type Instance } from './client.ts'
import type { PageFile } from './guards.ts'

const decodeCommit = Schema.decodeUnknownSync(CommitResponse)
const decodePlan = Schema.decodeUnknownSync(PlanResponse)

export const manifestOf = (files: ReadonlyArray<PageFile>): Promise<Manifest> =>
  Promise.all(
    files.map(async (file) => ({
      path: file.path,
      sha256: await sha256Hex(file.bytes),
      size: file.bytes.byteLength,
      contentType: file.contentType,
    })),
  )

const inParallel = async <A>(
  items: ReadonlyArray<A>,
  limit: number,
  run: (item: A) => Promise<void>,
): Promise<void> => {
  const queue = [...items]
  const worker = async (): Promise<void> => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await run(item)
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

export interface PublishOptions {
  /** Publish although a file looks like it holds a secret; the version records it. */
  readonly allowSecrets?: boolean
  /** Open the page to anyone (`public`) or close it to the team; left out, an old page stays as it is. */
  readonly visibility?: Visibility
}

export interface Published {
  readonly page: PageView
  readonly uploaded: number
  readonly replayed: boolean
}

/** Commits under one key; a `concurrent_publish` (another publish took the version number) is retried with it. */
export const commit = async (
  to: Instance,
  page: string,
  manifest: Manifest,
  key: string,
  options: PublishOptions = {},
  attempt = 0,
): Promise<typeof CommitResponse.Type> => {
  try {
    const request = {
      page,
      manifest,
      ...(options.allowSecrets === true ? { allowSecrets: true } : {}),
      ...(options.visibility === undefined ? {} : { visibility: options.visibility }),
    }
    const headers = { [idempotencyHeader]: key }
    return decodeCommit(await call(to, { method: 'POST', path: '/api/publish/commit', json: request, headers }))
  } catch (error) {
    if (error instanceof ApiError && error.code === 'concurrent_publish' && attempt < 3) {
      return commit(to, page, manifest, key, options, attempt + 1)
    }
    throw error
  }
}

export const publish = async (
  to: Instance,
  page: string,
  files: ReadonlyArray<PageFile>,
  options: PublishOptions = {},
): Promise<Published> => {
  const manifest = await manifestOf(files)
  const plan = decodePlan(await call(to, { method: 'POST', path: '/api/publish/plan', json: { page, manifest } }))
  const bytes = new Map(manifest.map((entry, index) => [entry.sha256, files[index]?.bytes]))
  await inParallel(plan.missing, 6, async (sha) => {
    await call(to, { method: 'PUT', path: `/api/blobs/${sha}`, bytes: bytes.get(sha) ?? new Uint8Array() })
  })
  const answer = await commit(to, page, manifest, `publish-${randomToken()}`, options)
  return { page: answer.page, uploaded: plan.missing.length, replayed: answer.replayed }
}
