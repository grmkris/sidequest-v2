/**
 * What a publish sends for a target:
 * - a folder: every file in it, and for each `.md` a rendered `.html` beside it (unless one is there already);
 *   `README.md` also becomes `index.html` when the folder has neither `index.html` nor `index.md`;
 * - a `.md` file anywhere: its rendered page as `index.html`.
 * A relative link to a file of the page stays relative (`.md` becomes `.html`); a link to anything else in the
 * repository becomes a GitHub link at the commit. A relative image is always published with the page: one outside
 * the page's folder is copied to `_files/`, so it shows by a share link too.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { contentTypeOf } from '../src/ContentType.ts'
import { filesOf } from './bundle.ts'
import { permalink, type RepoContext, repoContext, sourceLine } from './git.ts'
import type { PageFile } from './guards.ts'
import { markdownPage, type Parse, renderMarkdown } from './markdown.ts'

export interface BundleOptions {
  /** YYYY-MM-DD: the date rendered pages carry for the index. */
  readonly today: string
  /** Optional extra tags attached to rendered Markdown pages. */
  readonly tags?: ReadonlyArray<string> | undefined
  /** The Markdown parser; Bun's when absent (scripts/markdown.ts). */
  readonly parse?: Parse
}

const posix = (relative: string): string => relative.split(path.sep).join('/')
const text = (value: string) => new Uint8Array(new TextEncoder().encode(value))
const htmlType = 'text/html; charset=utf-8'

interface Source {
  /** The Markdown file. */
  readonly file: string
  /** Where its page goes, relative to the page's root. */
  readonly out: string
}

const isFile = (file: string): boolean => existsSync(file) && statSync(file).isFile()

/** The Markdown files of a folder that get a page, with where each page goes. */
const sourcesOf = (root: string, paths: ReadonlySet<string>): ReadonlyArray<Source> => {
  const pages = [...paths]
    .filter((file) => file.endsWith('.md') && !paths.has(`${file.slice(0, -3)}.html`))
    .map((file) => ({ file: path.join(root, file), out: `${file.slice(0, -3)}.html` }))
  const hasIndex = paths.has('index.html') || paths.has('index.md')
  return hasIndex || !paths.has('README.md')
    ? pages
    : [...pages, { file: path.join(root, 'README.md'), out: 'index.html' }]
}

interface Bundle {
  readonly root: string
  readonly repo: RepoContext | undefined
  /** Every path the page has, to tell a link inside the page from one outside it. */
  readonly paths: Set<string>
  /** Images pulled in by a Markdown file. */
  readonly extras: Map<string, PageFile>
}

const split = (href: string): readonly [string, string] => {
  const at = href.indexOf('#')
  return at === -1 ? [href, ''] : [href.slice(0, at), href.slice(at)]
}

const decoded = (target: string): string => {
  try {
    return decodeURIComponent(target)
  } catch {
    return target
  }
}

/** A link from a Markdown file: to a file of the page it stays relative, to the rest of the repository it goes to GitHub. */
const linkFrom =
  (bundle: Bundle, source: Source) =>
  (href: string): string => {
    const [target, hash] = split(href)
    const absolute = path.resolve(path.dirname(source.file), decoded(target))
    const inside = posix(path.relative(bundle.root, absolute))
    if (!inside.startsWith('..') && bundle.paths.has(inside)) {
      const page = inside.endsWith('.md') ? `${inside.slice(0, -3)}.html` : inside
      return posix(path.relative(path.posix.dirname(source.out), page)) + hash
    }
    if (bundle.repo === undefined) return href
    const repoPath = posix(path.relative(bundle.repo.root, absolute))
    if (repoPath.startsWith('..')) return href
    const isDirectory = existsSync(absolute) && statSync(absolute).isDirectory()
    return permalink(bundle.repo, repoPath + hash, isDirectory) ?? href
  }

/** An image from a Markdown file is published with the page, wherever it sits on disk. */
const imageFrom =
  (bundle: Bundle, source: Source) =>
  (src: string): string => {
    const [target, hash] = split(src)
    const absolute = path.resolve(path.dirname(source.file), decoded(target))
    if (!isFile(absolute)) return src
    const inside = posix(path.relative(bundle.root, absolute))
    const bytes = new Uint8Array(readFileSync(absolute))
    const kept = inside.startsWith('..')
      ? `_files/${createHash('sha256').update(bytes).digest('hex').slice(0, 8)}-${path.basename(absolute)}`
      : inside
    if (!bundle.paths.has(kept)) {
      bundle.paths.add(kept)
      bundle.extras.set(kept, { path: kept, bytes, contentType: contentTypeOf(kept) })
    }
    return posix(path.relative(path.posix.dirname(source.out), kept)) + hash
  }

const pageOf = (bundle: Bundle, source: Source, options: BundleOptions): PageFile => {
  const rendered = renderMarkdown(
    readFileSync(source.file, 'utf8'),
    { link: linkFrom(bundle, source), image: imageFrom(bundle, source) },
    options.parse,
  )
  const repoPath = bundle.repo === undefined ? undefined : posix(path.relative(bundle.repo.root, source.file))
  const html = markdownPage(rendered, {
    fallbackTitle: path.basename(source.file, '.md'),
    date: options.today,
    tags: options.tags,
    source: sourceLine(bundle.repo, repoPath),
  })
  return { path: source.out, bytes: text(html), contentType: htmlType }
}

/** The files a publish sends for a folder or a single Markdown file. */
export const pageFilesOf = (target: string, options: BundleOptions): ReadonlyArray<PageFile> => {
  const absolute = path.resolve(target)
  const folder = existsSync(absolute) && statSync(absolute).isDirectory()
  if (!folder && !(isFile(absolute) && absolute.endsWith('.md'))) {
    throw new Error(`${target}: publish a folder or a Markdown file`)
  }
  const root = folder ? absolute : path.dirname(absolute)
  const own = folder ? filesOf(root) : []
  const paths = new Set(own.map((file) => file.path))
  const sources = folder ? sourcesOf(root, paths) : [{ file: absolute, out: 'index.html' }]
  const bundle: Bundle = { root, repo: repoContext(absolute), paths, extras: new Map() }
  for (const source of sources) paths.add(source.out)
  const pages = sources.map((source) => pageOf(bundle, source, options))
  return [...own, ...pages, ...bundle.extras.values()].toSorted((a, b) => a.path.localeCompare(b.path))
}
