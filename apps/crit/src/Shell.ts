/** The pages the Worker writes itself: the team's index with its controls, and the short refusals. */
import { escapeHtml } from './Html.ts'
import { guardHeaders } from './Http.ts'
import type { PageView } from './Model.ts'

const shell = (title: string, body: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="/lib/base.css" />
  </head>
  <body>
    <main>
${body}
    </main>
  </body>
</html>
`

const html = (body: string, status: number): Response =>
  new Response(body, {
    status,
    headers: { ...guardHeaders, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })

/** What the index offers beside each page: decided by the site's settings, not by the page. */
export interface IndexOptions {
  /** Pages may be made public (`publicPages`). */
  readonly publicPages: boolean
  /** Share links exist (`outsiders` is not `none`). */
  readonly sharing: boolean
  /** Optional active tag filter (`?tag=...`). */
  readonly activeTag?: string | undefined
}

/** One plain form with one button: it works without any script, and the browser sends its Origin with it. */
const button = (action: string, label: string, hidden: Readonly<Record<string, string>> = {}) =>
  `<form method="post" action="${escapeHtml(action)}" class="inline">${Object.entries(hidden)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`)
    .join('')}<button type="submit">${escapeHtml(label)}</button></form>`

const controls = (page: PageView, options: IndexOptions): string => {
  const base = `/_crit/pages/${page.slug}`
  const isPublic = page.visibility === 'public'
  const parts = [
    isPublic
      ? `<span class="badge">public</span> <a href="/p/${page.slug}/">/p/${page.slug}/</a>`
      : '<span class="muted">team only</span>',
    isPublic
      ? button(`${base}/visibility`, 'Make private', { visibility: 'team' })
      : options.publicPages
        ? button(`${base}/visibility`, 'Make public', { visibility: 'public' })
        : '',
    options.sharing ? button(`${base}/links`, 'New share link') : '',
    page.links > 0 ? `<span class="muted">${page.links} share link${page.links === 1 ? '' : 's'}</span>` : '',
    page.links > 0 ? button(`${base}/links/revoke`, 'Revoke links') : '',
  ]
  return parts.filter((part) => part !== '').join(' ')
}

const tagPills = (tags: ReadonlyArray<string>): string =>
  tags.length === 0
    ? ''
    : ` ${tags.map((tag) => `<a class="tag" href="/?tag=${encodeURIComponent(tag)}">${escapeHtml(tag)}</a>`).join(' ')}`

const tagNav = (pages: ReadonlyArray<PageView>, activeTag: string | undefined): string => {
  const counts = new Map<string, number>()
  for (const page of pages) {
    for (const tag of page.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  if (counts.size === 0) return ''
  const sorted = [...counts.entries()].toSorted((a, b) => a[0].localeCompare(b[0]))
  const all = `<a class="tag-filter${activeTag === undefined ? ' active' : ''}" href="/">All (${pages.length})</a>`
  const items = sorted.map(
    ([tag, count]) =>
      `<a class="tag-filter${activeTag === tag ? ' active' : ''}" href="/?tag=${encodeURIComponent(tag)}">${escapeHtml(tag)} (${count})</a>`,
  )
  return `      <nav class="tags-nav" aria-label="Filter by tag">${[all, ...items].join(' ')}</nav>\n`
}

const row = (page: PageView, options: IndexOptions) => `        <li class="card">
          <a href="/${page.slug}/"><strong>${escapeHtml(page.title)}</strong></a>
          ${page.date === '' ? '' : `<span class="muted">${escapeHtml(page.date)}</span>`}${tagPills(page.tags)}
          ${page.description === '' ? '' : `<p>${escapeHtml(page.description)}</p>`}
          <p class="controls">${controls(page, options)}</p>
        </li>`

export const indexPage = (
  title: string,
  lead: string,
  pages: ReadonlyArray<PageView>,
  options: IndexOptions,
): Response => {
  const active = options.activeTag === undefined || options.activeTag === '' ? undefined : options.activeTag
  const shown = active === undefined ? pages : pages.filter((page) => page.tags.includes(active))
  return html(
    shell(
      title,
      `      <h1>${escapeHtml(title)}</h1>
      <p class="lead">${escapeHtml(lead)}</p>
${tagNav(pages, active)}      <ul class="pages">
${shown.map((page) => row(page, options)).join('\n')}
      </ul>`,
    ),
    200,
  )
}

/** A new share link, shown this once: only its hash is kept. */
export const linkPage = (slug: string, url: string, expiresAt: string | null): Response =>
  html(
    shell(
      'Share link',
      `      <p><a href="/">← All pages</a></p>
      <h1>Share link for ${escapeHtml(slug)}</h1>
      <p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>
      <p class="muted">Anyone with this link opens the page without signing in, ${
        expiresAt === null ? 'until it is revoked' : `until ${escapeHtml(expiresAt.slice(0, 10))}`
      }. It is shown only now: copy it before leaving this page.</p>`,
    ),
    200,
  )

/** A short page for a person who cannot have what they asked for. */
export const notice = (status: number, title: string, line: string): Response =>
  html(shell(title, `      <h1>${escapeHtml(title)}</h1>\n      <p>${escapeHtml(line)}</p>`), status)

export const notHere = (): Response => notice(404, 'Not here', 'This page does not exist, or its link no longer works.')
