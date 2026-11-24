/** What the index shows for a page, read from its `index.html`: the title, the description and the date. */

const unescape = (text: string): string =>
  text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')

const metaOf = (html: string, name: string): string => {
  for (const tag of html.match(/<meta\b[^>]*>/giu) ?? []) {
    if (new RegExp(`\\bname\\s*=\\s*["']${name}["']`, 'iu').test(tag)) {
      return unescape(
        /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/iu
          .exec(tag)
          ?.slice(1)
          .find((value) => value !== undefined) ?? '',
      )
    }
  }
  return ''
}

/** Normalizes a comma-separated tag list: lower-case, safe characters, deduplicated, up to 8 tags. */
export const parseTags = (raw: string): ReadonlyArray<string> => {
  const seen = new Set<string>()
  const out: Array<string> = []
  for (const part of raw.split(',')) {
    const clean = part
      .trim()
      .toLowerCase()
      .replaceAll(/[^a-z0-9._-]+/gu, '-')
      .replaceAll(/^-+|-+$/gu, '')
      .slice(0, 40)
    if (clean !== '' && !seen.has(clean)) {
      seen.add(clean)
      out.push(clean)
      if (out.length >= 8) break
    }
  }
  return out
}

export interface PageMeta {
  readonly title: string
  readonly description: string
  readonly date: string
  readonly tags: ReadonlyArray<string>
}

export const metaFrom = (html: string, slug: string): PageMeta => {
  const title = unescape(/<title[^>]*>([^<]*)<\/title>/iu.exec(html)?.[1]?.trim() ?? '')
  const date = metaOf(html, 'date').trim()
  const rawTags = [metaOf(html, 'tags'), metaOf(html, 'tag')].filter((value) => value !== '').join(',')
  return {
    title: (title === '' ? slug : title).slice(0, 200),
    description: metaOf(html, 'description').trim().slice(0, 500),
    date: /^\d{4}-\d{2}-\d{2}$/u.test(date) ? date : '',
    tags: parseTags(rawTags),
  }
}
