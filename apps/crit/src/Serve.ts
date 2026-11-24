/** Serves one file of a page's head version from R2, with conditionals and byte ranges (iPhone video needs a 206). */
import { Effect, Option } from 'effect'
import type { Env } from './Env.ts'
import { type Address, answerFor, etagOf, resolve } from './Files.ts'
import { attempt, guardHeaders, notFound, redirect } from './Http.ts'
import type { ManifestEntry, PageView } from './Model.ts'
import { manifestOf } from './Store.ts'

const fileHeaders = (entry: ManifestEntry): Record<string, string> => ({
  ...guardHeaders,
  'content-type': entry.contentType,
  etag: etagOf(entry),
  'accept-ranges': 'bytes',
  // Revalidated on every use: a publish shows at once, and an unchanged file costs a 304.
  'cache-control': 'private, no-cache',
})

const fileOf = Effect.fn('crit.serve.file')(function* (request: Request, env: Env, entry: ManifestEntry) {
  const headers = fileHeaders(entry)
  const answer = answerFor(request.headers, entry)
  if (answer.kind === 'not_modified') return new Response(null, { status: 304, headers })
  if (answer.kind === 'precondition_failed') return new Response(null, { status: 412, headers })
  if (answer.kind === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${entry.size}` } })
  }
  const part = answer.kind === 'part' ? answer.range : undefined
  if (part !== undefined) {
    headers['content-range'] = `bytes ${part.offset}-${part.offset + part.length - 1}/${entry.size}`
  }
  headers['content-length'] = String(part === undefined ? entry.size : part.length)
  const status = part === undefined ? 200 : 206
  if (request.method === 'HEAD') return new Response(null, { status, headers })
  const key = `blobs/${entry.sha256}`
  const object = yield* attempt(() => (part === undefined ? env.BLOBS.get(key) : env.BLOBS.get(key, { range: part })))
  if (object === null) return notFound()
  return new Response(object.body, { status, headers })
})

/**
 * A page's file for a GET or HEAD. `base` is the page's address as the reader opened it (`/<slug>/`, `/p/<slug>/`
 * or `/s/<token>/<slug>/`), which redirects are written against.
 */
export const servePage = Effect.fn('crit.serve.page')(function* (
  request: Request,
  env: Env,
  page: PageView,
  address: Address,
  base: string,
) {
  const { search } = new URL(request.url)
  if (address.path === undefined) return redirect(base + search)
  const manifest = yield* manifestOf(env.DB, page.slug, page.version)
  if (Option.isNone(manifest)) return notFound()
  const found = resolve(manifest.value, address.path)
  if (found.kind === 'slash') return redirect(base + found.path + search)
  if (found.kind === 'missing') return notFound()
  return yield* fileOf(request, env, found.entry)
})
