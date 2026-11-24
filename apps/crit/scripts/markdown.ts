/**
 * Markdown to a page at publish time, so the Workers never render anything: Bun's built-in parser (GFM tables and
 * task lists) and pele for Mermaid fences, drawn here as inline SVG. Every block gets a `data-review-id` from its
 * text, which the comments script anchors to (client/comments/place.ts). Relative links and images are rewritten by
 * the caller (scripts/pagefiles.ts).
 *
 * The parser is the one thing here that needs Bun, so it is a parameter: the unit tests (vitest, under Node) cover
 * everything around it, and `bun scripts/markdown-check.ts` renders a real document under Bun.
 */
import { render as drawDiagram } from 'pele'
import { escapeHtml } from '../src/Html.ts'
import { parseTags } from '../src/Meta.ts'

const unescapeHtml = (text: string): string =>
  text.replaceAll('&quot;', '"').replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&')

/** FNV-1a, 32 bits, as 8 hex characters: short ids from a block's text. */
export const shortHash = (text: string): string => {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

const stripTags = (html: string): string => html.replaceAll(/<[^>]*>/gu, '').trim()

/** Ids for the blocks of one document: `<kind>-<hash of the text>`, and `-1`, `-2` for a repeat. */
export const reviewIds = () => {
  const seen = new Map<string, number>()
  return (kind: string, html: string): string => {
    const base = `${kind}-${shortHash(stripTags(html))}`
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return count === 0 ? base : `${base}-${count}`
  }
}

export const isRelativeHref = (href: string): boolean => href !== '' && !/^(?:[a-z][a-z0-9+.-]*:|#|\/|\?)/iu.test(href)

export interface MarkdownOptions {
  /** Where a relative link goes; return it unchanged to keep it. */
  readonly link: (href: string) => string
  /** Where a relative image comes from. */
  readonly image: (src: string) => string
}

export interface RenderedMarkdown {
  readonly title: string | undefined
  /** The first paragraph's text, for the index. */
  readonly description: string
  /** YYYY-MM-DD from frontmatter, if present. */
  readonly date?: string | undefined
  /** Normalized tags from frontmatter, if present. */
  readonly tags?: ReadonlyArray<string> | undefined
  readonly body: string
}

interface Frontmatter {
  readonly title: string | undefined
  readonly description: string | undefined
  readonly date: string | undefined
  readonly tags: ReadonlyArray<string>
  readonly body: string
}

const unquote = (value: string): string => {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

const frontmatterFields = (block: string): ReadonlyMap<string, ReadonlyArray<string>> => {
  const fields = new Map<string, Array<string>>()
  for (const line of block.split(/\r?\n/u)) {
    const field = /^([a-z]+)\s*:\s*(.*)$/iu.exec(line.trim())
    const value = field === null ? '' : unquote(field[2] ?? '')
    if (field === null || value === '') continue
    const key = (field[1] ?? '').toLowerCase()
    const list = fields.get(key) ?? []
    list.push(value)
    fields.set(key, list)
  }
  return fields
}

/** Reads optional leading YAML frontmatter (`title`, `description`, `date`, `tag`, `tags`) and strips it from the body. */
export const splitFrontmatter = (source: string): Frontmatter => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(source)
  if (match === null) return { title: undefined, description: undefined, date: undefined, tags: [], body: source }
  const fields = frontmatterFields(match[1] ?? '')
  const rawDate = fields.get('date')?.at(-1)
  const rawTags = [...(fields.get('tag') ?? []), ...(fields.get('tags') ?? [])].map((v) => v.replace(/^\[|\]$/gu, ''))
  return {
    title: fields.get('title')?.at(-1),
    description: fields.get('description')?.at(-1),
    date: rawDate !== undefined && /^\d{4}-\d{2}-\d{2}$/u.test(rawDate) ? rawDate : undefined,
    tags: parseTags(rawTags.join(',')),
    body: source.slice(match[0].length),
  }
}

/** A Mermaid fence as inline SVG; one pele cannot draw stays readable as its source. */
export const diagramHtml = (source: string, id: string): string => {
  try {
    const { svg } = drawDiagram(source)
    return `<figure class="diagram" data-review-id="${id}" data-crit-source="${escapeHtml(source.trim())}">${svg}</figure>\n`
  } catch {
    return `<pre data-lang="mermaid" data-review-id="${id}"><code>${escapeHtml(source)}</code></pre>\n`
  }
}

/** The parser's signature: Bun's `Bun.markdown.render`. */
export type Parse = typeof Bun.markdown.render

interface Seen {
  title: string | undefined
  description: string
}

const aligned = (meta: { readonly align?: string } | undefined) =>
  meta?.align === undefined ? '' : ` style="text-align:${meta.align}"`

const blocks = (options: MarkdownOptions, mark: (kind: string, html: string) => string, seen: Seen) => {
  const attribute = (kind: string, children: string) => ` data-review-id="${mark(kind, children)}"`
  const callbacks: Parameters<Parse>[1] = {
    text: (text) => escapeHtml(text),
    heading: (children, meta) => {
      if (meta.level === 1 && seen.title === undefined) seen.title = unescapeHtml(stripTags(children))
      const id = meta.id === undefined ? '' : ` id="${escapeHtml(meta.id)}"`
      return `<h${meta.level}${id}${attribute('h', children)}>${children}</h${meta.level}>\n`
    },
    paragraph: (children) => {
      if (seen.description === '') seen.description = unescapeHtml(stripTags(children)).slice(0, 300)
      return `<p${attribute('p', children)}>${children}</p>\n`
    },
    blockquote: (children) => `<blockquote${attribute('q', children)}>${children}</blockquote>\n`,
    list: (children, meta) =>
      meta.ordered
        ? `<ol${meta.start !== undefined && meta.start !== 1 ? ` start="${meta.start}"` : ''}>${children}</ol>\n`
        : `<ul>${children}</ul>\n`,
    listItem: (children, meta) => {
      const box = meta.checked === undefined ? '' : `<input type="checkbox" disabled${meta.checked ? ' checked' : ''}> `
      return `<li${attribute('li', children)}>${box}${children}</li>\n`
    },
    hr: () => '<hr>\n',
    table: (children) => `<div class="table"><table>${children}</table></div>\n`,
    thead: (children) => `<thead>${children}</thead>`,
    tbody: (children) => `<tbody>${children}</tbody>`,
    tr: (children) => `<tr${attribute('tr', children)}>${children}</tr>\n`,
    th: (children, meta) => `<th${aligned(meta)}>${children}</th>`,
    td: (children, meta) => `<td${aligned(meta)}>${children}</td>`,
    html: (children) => children,
    strong: (children) => `<strong>${children}</strong>`,
    emphasis: (children) => `<em>${children}</em>`,
    strikethrough: (children) => `<del>${children}</del>`,
    codespan: (children) => `<code>${children}</code>`,
    link: (children, meta) => {
      const href = isRelativeHref(meta.href) ? options.link(meta.href) : meta.href
      const title = meta.title === undefined || meta.title === '' ? '' : ` title="${escapeHtml(meta.title)}"`
      return `<a href="${escapeHtml(href)}"${title}>${children}</a>`
    },
    image: (children, meta) => {
      const src = isRelativeHref(meta.src) ? options.image(meta.src) : meta.src
      return `<img src="${escapeHtml(src)}" alt="${escapeHtml(stripTags(children))}" loading="lazy">`
    },
    code: (children, meta) => {
      const language = meta?.language ?? ''
      if (language === 'mermaid') return diagramHtml(unescapeHtml(children), mark('d', children))
      const lang = language === '' ? '' : ` data-lang="${escapeHtml(language)}"`
      return `<pre${lang}${attribute('code', children)}><code>${children}</code></pre>\n`
    },
  }
  return callbacks
}

export const renderMarkdown = (
  source: string,
  options: MarkdownOptions,
  parse: Parse = Bun.markdown.render,
): RenderedMarkdown => {
  const front = splitFrontmatter(source)
  const seen: Seen = { title: front.title, description: front.description ?? '' }
  const body = parse(front.body, blocks(options, reviewIds(), seen), { headings: { ids: true } })
  return { title: seen.title, description: seen.description, date: front.date, tags: front.tags, body }
}

export interface PageFrame {
  readonly fallbackTitle: string
  /** YYYY-MM-DD, for the index. */
  readonly date: string
  /** Optional tags merged with any frontmatter tags. */
  readonly tags?: ReadonlyArray<string> | undefined
  /** Where the page came from, as plain text; empty for none. */
  readonly source: string
}

/** The whole page around a rendered document: the site's look, comments on, and the tags the index reads. */
export const markdownPage = (rendered: RenderedMarkdown, frame: PageFrame): string => {
  const date = rendered.date ?? frame.date
  const tags = parseTags([...(rendered.tags ?? []), ...(frame.tags ?? [])].join(','))
  const tagsMeta = tags.length === 0 ? '' : `\n    <meta name="tags" content="${escapeHtml(tags.join(', '))}" />`
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${escapeHtml(rendered.title ?? frame.fallbackTitle)}</title>
    <meta name="description" content="${escapeHtml(rendered.description)}" />
    <meta name="date" content="${escapeHtml(date)}" />${tagsMeta}
    <link rel="stylesheet" href="/lib/base.css" />
    <script src="/lib/comments.js" defer></script>
  </head>
  <body>
    <main class="prose">
${rendered.body}${frame.source === '' ? '' : `<footer>${escapeHtml(frame.source)}</footer>\n`}    </main>
  </body>
</html>
`
}
