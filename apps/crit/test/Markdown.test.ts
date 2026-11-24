import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { anchorFor } from '../client/comments/place.ts'
import { githubSlug, permalink, type RepoContext, sourceLine } from '../scripts/git.ts'
import {
  diagramHtml,
  isRelativeHref,
  markdownPage,
  type Parse,
  renderMarkdown,
  reviewIds,
  shortHash,
  splitFrontmatter,
} from '../scripts/markdown.ts'
import { pageFilesOf } from '../scripts/pagefiles.ts'

/**
 * Bun's parser does not exist under Node, so these tests drive the callbacks the way it would for one small document:
 * a heading, a paragraph with a link and an image, and a Mermaid fence. `bun scripts/markdown-check.ts` covers the
 * real parser.
 */
const parse: Parse = (_source, callbacks = {}) =>
  [
    callbacks.heading?.('Plan', { level: 1, id: 'plan' }),
    callbacks.paragraph?.(
      `See ${callbacks.link?.('the notes', { href: 'notes.md#top' })} and ${callbacks.link?.('the code', { href: '../src/app.ts' })}. ${callbacks.image?.('a shot', { src: '../shots/a.png' })}${callbacks.image?.('own', { src: 'own.png' })}`,
    ),
    callbacks.code?.('flowchart LR\n  A --&gt; B', { language: 'mermaid' }),
  ].join('')

const free = () => false
const none = { link: (href: string) => href, image: (src: string) => src }

describe('review ids', () => {
  it('come from the block text, and a repeat gets a number', () => {
    const mark = reviewIds()
    expect(mark('p', '<em>Same</em> text')).toBe(`p-${shortHash('Same text')}`)
    expect(mark('p', 'Same text')).toBe(`p-${shortHash('Same text')}-1`)
    expect(mark('li', 'Same text')).toBe(`li-${shortHash('Same text')}`)
    expect(shortHash('abc')).toMatch(/^[0-9a-f]{8}$/u)
  })

  it('anchor a comment by name when the element has one, else by its text', () => {
    const block = { section: 'plan', kind: 'p', label: 'Some text' }
    expect(anchorFor({ ...block, reviewId: 'p-1a2b3c4d' }, free)).toBe('r/p-1a2b3c4d')
    // The name stays when the text and the section change.
    expect(anchorFor({ section: 'other', kind: 'p', label: 'Edited text', reviewId: 'p-1a2b3c4d' }, free)).toBe(
      'r/p-1a2b3c4d',
    )
    expect(anchorFor({ ...block, reviewId: undefined }, free)).toMatch(/^plan\/p\/[0-9a-z]+$/u)
    expect(anchorFor({ ...block, reviewId: 'not a name' }, free)).toMatch(/^plan\/p\//u)
    expect(anchorFor({ ...block, reviewId: 'twice' }, (id) => id === 'r/twice')).toBe('r/twice+')
  })
})

describe('rendering', () => {
  it('tells relative addresses from the rest', () => {
    for (const href of ['notes.md', '../a/b.png', 'a b.html#x'])
      expect({ href, relative: isRelativeHref(href) }).toEqual({ href, relative: true })
    for (const href of ['', '#top', '/lib/base.css', 'https://x.test/', 'mailto:a@b.c', '?q=1']) {
      expect({ href, relative: isRelativeHref(href) }).toEqual({ href, relative: false })
    }
  })

  it('marks blocks, takes the title and description, and draws a Mermaid fence with pele', () => {
    const rendered = renderMarkdown('', none, parse)
    expect(rendered.title).toBe('Plan')
    expect(rendered.description).toContain('See the notes and the code.')
    expect(rendered.body).toContain(`<h1 id="plan" data-review-id="h-${shortHash('Plan')}">Plan</h1>`)
    expect(rendered.body).toMatch(
      /<figure class="diagram" data-review-id="d-[0-9a-f]{8}" data-crit-source="flowchart LR/u,
    )
    expect(rendered.body).toContain('class="pele')
  })

  it('keeps a diagram pele cannot draw as its source', () => {
    expect(diagramHtml('not a diagram at all', 'd-1')).toBe(
      '<pre data-lang="mermaid" data-review-id="d-1"><code>not a diagram at all</code></pre>\n',
    )
  })

  it('wraps a page with the tags the index reads and the comments script', () => {
    const page = markdownPage(
      { title: 'A & B', description: 'One "line".', tags: ['research'], body: '<p>x</p>\n' },
      { fallbackTitle: 'plan', date: '2026-11-13', tags: ['notes'], source: 'From a/b · plan.md at 1234abcd' },
    )
    expect(page).toContain('<title>A &amp; B</title>')
    expect(page).toContain('<meta name="description" content="One &quot;line&quot;." />')
    expect(page).toContain('<meta name="date" content="2026-11-13" />')
    expect(page).toContain('<meta name="tags" content="research, notes" />')
    expect(page).toContain('<script src="/lib/comments.js" defer></script>')
    expect(page).toContain('<footer>From a/b · plan.md at 1234abcd</footer>')
    expect(
      markdownPage({ title: undefined, description: '', body: '' }, { fallbackTitle: 'plan', date: '', source: '' }),
    ).toContain('<title>plan</title>')
  })

  it('parses optional YAML frontmatter for title, description, date and tags and strips it from the body', () => {
    const md = `---
title: "Personal Note"
description: Short summary.
date: 2026-11-24
tags: [Notes, kris.gg]
---
# Ignored H1
Body text.`
    const front = splitFrontmatter(md)
    expect(front.title).toBe('Personal Note')
    expect(front.description).toBe('Short summary.')
    expect(front.date).toBe('2026-11-24')
    expect(front.tags).toEqual(['notes', 'kris.gg'])
    expect(front.body).toBe('# Ignored H1\nBody text.')
  })
})

const tree = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'crit-md-'))
  mkdirSync(path.join(root, 'page'))
  mkdirSync(path.join(root, 'shots'))
  writeFileSync(path.join(root, 'page', 'README.md'), '# Plan')
  writeFileSync(path.join(root, 'page', 'notes.md'), '# Notes')
  writeFileSync(path.join(root, 'page', 'own.png'), 'own')
  writeFileSync(path.join(root, 'shots', 'a.png'), 'outside')
  return root
}

describe('what a publish sends', () => {
  it('renders each Markdown file of a folder, and README.md as the index', () => {
    const files = pageFilesOf(path.join(tree(), 'page'), { today: '2026-11-13', parse })
    const paths = files.map((file) => file.path)
    expect(paths).toContain('index.html')
    expect(paths).toContain('README.html')
    expect(paths).toContain('notes.html')
    expect(paths).toContain('own.png')
    const index = new TextDecoder().decode(files.find((file) => file.path === 'index.html')?.bytes)
    // A link to a page of the folder stays relative, as the rendered page.
    expect(index).toContain('<a href="notes.html#top">')
    // A picture outside the folder is published with the page, never linked to GitHub.
    const copied = paths.find((file) => file.startsWith('_files/'))
    expect(copied).toMatch(/^_files\/[0-9a-f]{8}-a\.png$/u)
    expect(index).toContain(`<img src="${copied}" alt="a shot"`)
    expect(index).toContain('<img src="own.png" alt="own"')
    expect(new TextDecoder().decode(files.find((file) => file.path === copied)?.bytes)).toBe('outside')
  })

  it('publishes one Markdown file as the index, with the pictures it shows', () => {
    const files = pageFilesOf(path.join(tree(), 'page', 'README.md'), { today: '2026-11-13', parse })
    expect(files.map((file) => file.path).toSorted()).toEqual(expect.arrayContaining(['index.html', 'own.png']))
    expect(files.some((file) => file.path.endsWith('.md'))).toBe(false)
    expect(files.filter((file) => file.path.startsWith('_files/'))).toHaveLength(1)
  })

  it('refuses a target that is neither a folder nor a Markdown file', () => {
    expect(() => pageFilesOf(path.join(tree(), 'shots', 'a.png'), { today: '', parse })).toThrow(
      /folder or a Markdown/u,
    )
  })
})

describe('links into the repository', () => {
  const repo: RepoContext = {
    root: '/repo',
    github: 'owner/name',
    commit: 'c'.repeat(40),
    branch: 'main',
    pushed: true,
    dirty: false,
  }

  it('reads the GitHub name from either remote form', () => {
    expect(githubSlug('git@github.com:owner/name.git')).toBe('owner/name')
    expect(githubSlug('https://github.com/owner/name')).toBe('owner/name')
    expect(githubSlug('https://example.test/owner/name.git')).toBeUndefined()
  })

  it('pins a pushed commit, and falls back to the branch for one that is not', () => {
    expect(permalink(repo, 'src/app.ts#L3-L9', false)).toBe(
      `https://github.com/owner/name/blob/${'c'.repeat(40)}/src/app.ts#L3-L9`,
    )
    expect(permalink({ ...repo, pushed: false }, 'docs', true)).toBe('https://github.com/owner/name/tree/main/docs')
    expect(permalink({ ...repo, github: undefined }, 'a', false)).toBeUndefined()
  })

  it('says where a page came from', () => {
    expect(sourceLine(repo, 'docs/plan.md')).toBe('From owner/name · docs/plan.md at cccccccc')
    expect(sourceLine({ ...repo, pushed: false, dirty: true }, 'a.md')).toBe(
      'From owner/name · a.md at main (not pushed) · with uncommitted changes',
    )
    expect(sourceLine(undefined, 'a.md')).toBe('')
  })
})
