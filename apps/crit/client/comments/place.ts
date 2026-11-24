/**
 * Pure address arithmetic for the page script: from where a page is open, which page it is and where its comments
 * live. A page is open at `/<slug>/…` for the team, at `/p/<slug>/…` when it is public, and at
 * `/s/<token>/<slug>/…` by a share link; its comments are under that same address, at `…/_crit/comments`.
 */

export interface Place {
  /** The comments endpoint for this page, as the reader opened it. */
  readonly api: string
  /** The page id: the page's name plus the path inside it, without a trailing slash or `index.html`. */
  readonly page: string
  /** Opened in public or by a share link, so the reader is a guest and not a signed-in member. */
  readonly guest: boolean
}

/** A path segment as the server's page-id pattern takes it: percent-encoded, whatever the browser left bare. */
const segment = (raw: string): string => {
  let text = raw
  try {
    text = decodeURIComponent(raw)
  } catch {
    // A malformed escape stays as typed; the server refuses it.
  }
  return encodeURIComponent(text).replaceAll(/[!'()*]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

const pageId = (slug: string, rest: string): string => {
  const parts = rest.split('/').filter((part) => part !== '')
  if (parts.at(-1) === 'index.html') parts.pop()
  return [slug, ...parts.map(segment)].join('/')
}

/** First segments that are crit's own addresses, never a page's name (src/Model.ts `reservedSlugs`). */
const reserved = ['p', 's', 'api', 'mcp', 'lib', '_crit', 'cdn-cgi']

/** Undefined when the address is not a page's (the index, `/lib/…`). */
export const placeOf = (pathname: string): Place | undefined => {
  const shared = /^\/s\/([A-Za-z0-9_-]{22})\/([a-z0-9_][a-z0-9_-]{0,79})(\/.*)?$/u.exec(pathname)
  if (shared !== null) {
    const [, token = '', slug = '', rest = ''] = shared
    return { api: `/s/${token}/${slug}/_crit/comments`, page: pageId(slug, rest), guest: true }
  }
  const open = /^\/p\/([a-z0-9_][a-z0-9_-]{0,79})(\/.*)?$/u.exec(pathname)
  if (open !== null) {
    const [, slug = '', rest = ''] = open
    return { api: `/p/${slug}/_crit/comments`, page: pageId(slug, rest), guest: true }
  }
  const own = /^\/([a-z0-9_][a-z0-9_-]{0,79})(\/.*)?$/u.exec(pathname)
  if (own === null) return undefined
  const [, slug = '', rest = ''] = own
  if (reserved.includes(slug)) return undefined
  return { api: `/${slug}/_crit/comments`, page: pageId(slug, rest), guest: false }
}

/** Anchor ids hash the text they point at: stable while the text stays the same. */
export const hash = (text: string): string => {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0
  return h.toString(36)
}

export const sectionSlug = (text: string): string =>
  text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-|-$/gu, '')
    .slice(0, 40)

/** Anchor id = nearest h1/h2 section + element kind + hash of its own text; a repeat gets a `+`. */
export const anchorId = (section: string, kind: string, label: string, taken: (id: string) => boolean): string => {
  let id = `${section}/${kind}/${hash(label)}`
  while (taken(id)) id += '+'
  return id
}

/**
 * An element that names itself with `data-review-id` (every block of a page rendered from Markdown does, and any
 * page may) is anchored by that name: `r/<id>`. The author decides when it changes, so a comment stays on its block
 * through edits to the text. Without one, the anchor is the text's hash.
 */
export const anchorFor = (
  element: {
    readonly reviewId: string | undefined
    readonly section: string
    readonly kind: string
    readonly label: string
  },
  taken: (id: string) => boolean,
): string => {
  const named = (element.reviewId ?? '').trim()
  if (named === '' || !/^[A-Za-z0-9._:-]{1,120}$/u.test(named)) {
    return anchorId(element.section, element.kind, element.label, taken)
  }
  let id = `r/${named}`
  while (taken(id)) id += '+'
  return id
}
