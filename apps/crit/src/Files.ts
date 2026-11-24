/**
 * Pure decisions for serving a file: which manifest entry a path asks for, and what a request's conditional and range
 * headers mean for it. The entity tag is the file's sha256, so it is the same on every surface and after every publish.
 */
import type { Manifest, ManifestEntry } from './Model.ts'

export type Resolution =
  | { readonly kind: 'file'; readonly entry: ManifestEntry }
  | { readonly kind: 'slash'; readonly path: string }
  | { readonly kind: 'missing' }

/** The file itself, else the folder's `index.html`; a folder asked for without its slash is a redirect. */
export const resolve = (manifest: Manifest, path: string): Resolution => {
  const byPath = new Map(manifest.map((entry) => [entry.path, entry]))
  const wanted = path === '' || path.endsWith('/') ? `${path}index.html` : path
  const direct = byPath.get(wanted)
  if (direct !== undefined) return { kind: 'file', entry: direct }
  if (path !== '' && !path.endsWith('/') && byPath.has(`${path}/index.html`)) return { kind: 'slash', path: `${path}/` }
  return { kind: 'missing' }
}

/** Types Cloudflare's edge may compress on the way out; it drops a strong entity tag when it does, and keeps a weak one. */
const compressible = (contentType: string): boolean =>
  /^text\/|^application\/(json|javascript|xml|wasm)|^image\/svg\+xml|^font\/(ttf|otf)/u.test(contentType)

/**
 * The file's sha256: weak for text the edge may compress, strong for everything else (a range needs a strong one).
 * Cloudflare sends HTML without any entity tag, so a page's own HTML is always sent whole; its files revalidate.
 */
export const etagOf = (entry: ManifestEntry): string =>
  compressible(entry.contentType) ? `W/"${entry.sha256}"` : `"${entry.sha256}"`

const opaque = (tag: string): string => tag.trim().replace(/^W\//u, '')
const matches = (header: string, etag: string): boolean =>
  header.trim() === '*' || header.split(',').map(opaque).includes(opaque(etag))

export type Byte = { readonly offset: number; readonly length: number }

/**
 * One `bytes=` range against a file's size: the bytes to send, `unsatisfiable`, or `ignore` for a header this server
 * does not honour (another unit, several ranges, or nonsense), which is answered with the whole file.
 */
export const rangeOf = (header: string, size: number): Byte | 'unsatisfiable' | 'ignore' => {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim())
  if (match === null) return 'ignore'
  const [first, last] = [match[1] ?? '', match[2] ?? '']
  if (first === '' && last === '') return 'ignore'
  if (first === '') {
    const suffix = Number(last)
    if (suffix === 0 || size === 0) return 'unsatisfiable'
    const length = Math.min(suffix, size)
    return { offset: size - length, length }
  }
  const offset = Number(first)
  if (offset >= size) return 'unsatisfiable'
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1)
  if (end < offset) return 'ignore'
  return { offset, length: end - offset + 1 }
}

export type Answer =
  | { readonly kind: 'not_modified' }
  | { readonly kind: 'precondition_failed' }
  | { readonly kind: 'unsatisfiable' }
  | { readonly kind: 'whole' }
  | { readonly kind: 'part'; readonly range: Byte }

/** What to answer for a file, from the request's `If-Match`, `If-None-Match`, `If-Range` and `Range` headers. */
export const answerFor = (headers: Headers, entry: ManifestEntry): Answer => {
  const etag = etagOf(entry)
  const ifMatch = headers.get('if-match')
  if (ifMatch !== null && !matches(ifMatch, etag)) return { kind: 'precondition_failed' }
  const ifNoneMatch = headers.get('if-none-match')
  if (ifNoneMatch !== null && matches(ifNoneMatch, etag)) return { kind: 'not_modified' }
  const range = headers.get('range')
  if (range === null) return { kind: 'whole' }
  const ifRange = headers.get('if-range')
  // If-Range compares strongly: a weak tag never earns a part.
  if (ifRange !== null && (etag.startsWith('W/') || ifRange.trim() !== etag)) return { kind: 'whole' }
  const wanted = rangeOf(range, entry.size)
  if (wanted === 'ignore') return { kind: 'whole' }
  if (wanted === 'unsatisfiable') return { kind: 'unsatisfiable' }
  return wanted.offset === 0 && wanted.length === entry.size ? { kind: 'whole' } : { kind: 'part', range: wanted }
}

/** A page's name and the path in it, whatever stands in front (nothing, `/p`, or `/s/<token>`). */
export type Address = { readonly slug: string; readonly path: string | undefined }

const decode = (text: string): string | undefined => {
  try {
    return decodeURIComponent(text)
  } catch {
    return undefined
  }
}

/** `/<slug>` (no slash yet: `path` undefined) or `/<slug>/<path>`; undefined for anything else. */
export const addressOf = (pathname: string): Address | undefined => {
  const match = /^\/([a-z0-9_][a-z0-9_-]{0,79})(\/.*)?$/u.exec(pathname)
  if (match === null) return undefined
  const slug = match[1] ?? ''
  if (match[2] === undefined) return { slug, path: undefined }
  const path = decode(match[2].slice(1))
  return path === undefined ? undefined : { slug, path }
}

/** `/p/<slug>…`, a public page's address; undefined for `/p` alone and anything else. */
export const publicAddressOf = (pathname: string): Address | undefined =>
  pathname.startsWith('/p/') ? addressOf(pathname.slice(2)) : undefined

/** `/s/<token>/<rest>`: the token and the address after it. */
export const sharedAddressOf = (
  pathname: string,
): { readonly token: string; readonly address: Address } | undefined => {
  const match = /^\/s\/([A-Za-z0-9_-]{22})(\/.*)$/u.exec(pathname)
  if (match === null) return undefined
  const address = addressOf(match[2] ?? '')
  return address === undefined ? undefined : { token: match[1] ?? '', address }
}
