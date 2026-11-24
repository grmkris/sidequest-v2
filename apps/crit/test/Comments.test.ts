import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { anchorId, hash, placeOf, sectionSlug } from '../client/comments/place.ts'
import { agentThreads } from '../src/CommentApi.ts'
import { threadsMarkdown } from '../src/CommentMarkdown.ts'
import { guestMayPost, guestPostsPerWindow, PageId, slugOf } from '../src/CommentModel.ts'
import type { AgentRow } from '../src/CommentStore.ts'
import { commentsRest } from '../src/Comments.ts'
import { threadsOf } from '../src/Threads.ts'

const isPage = Schema.is(PageId)
const token = 'A'.repeat(22)

describe('page ids', () => {
  it('takes a page, a folder inside it and a file inside it', () => {
    for (const id of ['spike', '_template', 'spike/notes', 'spike/sub/page.html', 'spike/a%20b/c.html']) {
      expect({ id, page: isPage(id) }).toEqual({ id, page: true })
    }
    expect(slugOf('spike/sub/page.html')).toBe('spike')
  })

  it('refuses anything that is not a page of this site', () => {
    for (const id of [
      '',
      '/spike',
      'spike/',
      'Spike',
      'spike/../other',
      'spike/./x',
      'spike//x',
      'spike/a b',
      'spike?x=1',
    ]) {
      expect({ id, page: isPage(id) }).toEqual({ id, page: false })
    }
    expect(isPage(`spike/${'a'.repeat(400)}`)).toBe(false)
  })
})

describe('where a page is open', () => {
  it('signed in: the page id is the address, and comments are under the page', () => {
    expect(placeOf('/spike/')).toEqual({ api: '/spike/_crit/comments', page: 'spike', guest: false })
    expect(placeOf('/spike/sub/page.html')?.api).toBe('/spike/_crit/comments')
    expect(placeOf('/spike/index.html')?.page).toBe('spike')
    expect(placeOf('/spike/notes/')?.page).toBe('spike/notes')
    expect(placeOf('/spike/sub/page.html')?.page).toBe('spike/sub/page.html')
    expect(placeOf('/spike/a%20b/c.html')?.page).toBe('spike/a%20b/c.html')
  })

  it('by a share link: the same page id, and comments under the link', () => {
    const place = placeOf(`/s/${token}/spike/sub/page.html`)
    expect(place).toEqual({ api: `/s/${token}/spike/_crit/comments`, page: 'spike/sub/page.html', guest: true })
    expect(placeOf(`/s/${token}/spike/`)?.page).toBe('spike')
  })

  it('in public: the same page id, and comments under /p/', () => {
    expect(placeOf('/p/spike/')).toEqual({ api: '/p/spike/_crit/comments', page: 'spike', guest: true })
    expect(placeOf('/p/spike/notes/')?.page).toBe('spike/notes')
  })

  it('is nowhere on the index and the library', () => {
    for (const path of ['/', '/lib/base.css', '/api/comments', '/s/short/spike/', '/p/', '/mcp', '/_crit/pages/x'])
      expect({ path, place: placeOf(path) }).toEqual({ path, place: undefined })
  })

  it('every page id the script makes is one the server takes', () => {
    for (const path of ['/spike/', '/spike/a b/c (1).html', '/spike/über/', `/s/${token}/spike/x%2Fy/`]) {
      expect({ path, page: isPage(placeOf(path)?.page ?? '') }).toEqual({ path, page: true })
    }
  })

  it("knows a shared page's comment routes from its files", () => {
    expect(commentsRest('_crit/comments')).toBe('')
    expect(commentsRest('_crit/comments/abc')).toBe('/abc')
    for (const path of [undefined, '', 'index.html', '_crit', '_crit/commentsx'])
      expect(commentsRest(path)).toBeUndefined()
  })
})

describe('anchors', () => {
  it('hashes text the same way every time, and differently for other text', () => {
    expect(hash('Hello')).toBe(hash('Hello'))
    expect(hash('Hello')).not.toBe(hash('Hello.'))
    expect(hash('')).toBe('45h')
  })

  it('names an element by its section, its kind and its text, and tells repeats apart', () => {
    const taken = new Set<string>()
    const first = anchorId(sectionSlug('The Plan: step 1!'), 'li', 'Ship it', (id) => taken.has(id))
    taken.add(first)
    const second = anchorId('the-plan-step-1', 'li', 'Ship it', (id) => taken.has(id))
    expect(first).toBe(`the-plan-step-1/li/${hash('Ship it')}`)
    expect(second).toBe(`${first}+`)
  })
})

const row = (over: Partial<AgentRow> & Pick<AgentRow, 'id'>): AgentRow => ({
  page: 'spike',
  slug: 'spike',
  anchor: 'top/h1/abc',
  anchor_text: 'Spike',
  author: 'Mira',
  author_kind: 'member',
  author_key_hash: 'k',
  body: 'Is this the final copy?',
  created_at: '2026-11-13T10:00:00.000Z',
  parent_id: null,
  status: 'open',
  status_by: null,
  status_at: null,
  link_hash: null,
  page_title: 'Spike & film',
  page_removed: 0,
  ...over,
})
const one = '11111111-1111-4111-8111-111111111111'
const two = '22222222-2222-4222-8222-222222222222'
const three = '33333333-3333-4333-8333-333333333333'
const rows = [
  row({ id: one }),
  row({
    id: two,
    parent_id: one,
    author: 'Ana',
    author_kind: 'guest',
    body: 'Yes.\nSecond line',
    created_at: '2026-11-13T11:00:00.000Z',
  }),
  row({
    id: three,
    anchor_text: 'A card',
    status: 'resolved',
    status_by: 'Mira',
    status_at: '2026-11-13T12:00:00.000Z',
    created_at: '2026-11-13T09:00:00.000Z',
  }),
]

describe('threads', () => {
  it('puts each reply under its thread, replies oldest first, and a reply to a reply in the same thread', () => {
    const deep = { id: 'd', parentId: 'b', createdAt: '3' }
    const threads = threadsOf([
      deep,
      { id: 'b', parentId: 'a', createdAt: '2' },
      { id: 'a', parentId: null, createdAt: '1' },
    ])
    expect(threads).toHaveLength(1)
    expect(threads[0]?.root.id).toBe('a')
    expect(threads[0]?.replies.map((reply) => reply.id)).toEqual(['b', 'd'])
  })

  it('starts a thread from a reply whose parent is gone', () => {
    expect(threadsOf([{ id: 'x', parentId: 'gone', createdAt: '1' }]).map((thread) => thread.root.id)).toEqual(['x'])
  })

  it('filters by status, by page inside a name, and by anything new since a time', () => {
    const all = agentThreads(rows, { page: undefined, status: 'all', since: undefined })
    expect(all.map((thread) => thread.root.id)).toEqual([three, one])
    expect(
      agentThreads(rows, { page: undefined, status: 'open', since: undefined }).map((thread) => thread.root.id),
    ).toEqual([one])
    expect(agentThreads(rows, { page: 'spike/notes', status: 'all', since: undefined })).toEqual([])
    const since = agentThreads(rows, { page: 'spike', status: 'all', since: '2026-11-13T10:30:00.000Z' })
    expect(since.map((thread) => thread.root.id)).toEqual([three, one])
    expect(agentThreads(rows, { page: 'spike', status: 'all', since: '2026-11-13T12:30:00.000Z' })).toEqual([])
  })
})

describe('the comments as Markdown', () => {
  const threads = agentThreads(rows, { page: undefined, status: 'all', since: undefined })

  it("groups by page, open threads first, with each thread's id, anchor text and a link to the page", () => {
    const text = threadsMarkdown(threads, 'https://team.example.com')
    expect(text).toContain('# Comments: 1 open of 2 threads')
    expect(text).toContain('## Spike & film (spike)\nhttps://team.example.com/spike')
    expect(text.indexOf('"Spike" [open]')).toBeLessThan(text.indexOf('"A card" [resolved by Mira]'))
    expect(text).toContain(`thread \`${one}\``)
    expect(text).toContain('- **Mira**, 2026-11-13 10:00:\n  Is this the final copy?')
    expect(text).toContain('  - **Ana (guest)**, 2026-11-13 11:00:\n    Yes.\n    Second line')
  })

  it('says when a page was taken down, and when there is nothing', () => {
    const gone = agentThreads([row({ id: one, page_removed: 1 })], { page: undefined, status: 'all', since: undefined })
    const text = threadsMarkdown(gone, 'https://team.example.com')
    expect(text).toContain('this page was taken down')
    expect(text).not.toContain('https://team.example.com/spike')
    expect(threadsMarkdown([], undefined)).toBe('No comments.\n')
  })
})

describe('the guest rate limit', () => {
  it('takes comments up to the limit in a window, then none', () => {
    expect(guestMayPost(0)).toBe(true)
    expect(guestMayPost(guestPostsPerWindow - 1)).toBe(true)
    expect(guestMayPost(guestPostsPerWindow)).toBe(false)
  })
})
