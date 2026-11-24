/**
 * The comments part of the journey (Journey.native.test.ts): a member signed in, a guest by a share link, a guest on
 * the public page, and an agent with the publish token, all on one page.
 */
import { expect } from 'bun:test'
import { Schema } from 'effect'
import { call, type Instance, read } from '../scripts/client.ts'
import { CommentView, guestPostsPerWindow, Reader, ThreadsResponse } from '../src/CommentModel.ts'

const Listing = Schema.Struct({ reader: Reader, comments: Schema.Array(CommentView) })
const decodeListing = Schema.decodeUnknownSync(Listing)
const decodeComment = Schema.decodeUnknownSync(CommentView)
const decodeThreads = Schema.decodeUnknownSync(ThreadsResponse)
const ErrorBody = Schema.Struct({ error: Schema.String })

/** One reader's view of a comments endpoint: a member (their Access token) or a guest with their browser's key. */
export interface Seat {
  readonly base: string
  readonly headers: Readonly<Record<string, string>>
}

const send = (seat: Seat, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${seat.base}${path}`, {
    method,
    headers: { ...seat.headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

/** The status and the problem's word, e.g. `403 not_yours`; just the status for a success. */
const outcome = async (response: Response): Promise<string> => {
  if (response.ok) return String(response.status)
  const body: unknown = await response.json().catch(() => undefined)
  return `${response.status} ${Schema.is(ErrorBody)(body) ? body.error : ''}`.trim()
}

const draft = (page: string, body: string, parentId: string | null = null, name?: string) => ({
  page,
  anchor: 'top/h1/abc',
  anchorText: 'Spike',
  parentId,
  body,
  ...(name === undefined ? {} : { name }),
})

const post = async (seat: Seat, input: ReturnType<typeof draft>) =>
  decodeComment(await (await send(seat, 'POST', '', input)).json())
const listing = async (seat: Seat, page: string) =>
  decodeListing(await (await send(seat, 'GET', `?page=${encodeURIComponent(page)}`)).json())

const asMember = async (member: Seat) => {
  const first = await post(member, draft('spike', 'Is this the final copy?'))
  expect(first).toMatchObject({ author: 'Mira', authorKind: 'member', mine: true, status: 'open', page: 'spike' })
  const seen = await listing(member, 'spike')
  expect(seen.reader).toEqual({ kind: 'member', name: 'Mira', canComment: true, canResolve: true })
  expect(seen.comments.map((comment) => comment.id)).toEqual([first.id])

  // Pages inside the page take comments of their own; a page that is not there takes none.
  for (const page of ['spike/notes', 'spike/sub/page.html']) {
    expect((await post(member, draft(page, `On ${page}`))).page).toBe(page)
    expect((await listing(member, page)).comments).toHaveLength(1)
  }
  expect(await outcome(await send(member, 'POST', '', draft('spike/nope.html', 'x')))).toBe('404 page_not_found')
  // Comments are asked for under one page's address: another page's are not there.
  expect(await outcome(await send(member, 'POST', '', draft('other', 'x')))).toBe('404 not_found')
  expect(await outcome(await send(member, 'GET', '?page=other'))).toBe('404 not_found')
  expect(await outcome(await send(member, 'GET', '?page=..%2Fx'))).toBe('400 page_required')

  // A write must come from the page itself, as JSON.
  const foreign = await send(member, 'POST', '', draft('spike', 'x'), { origin: 'https://elsewhere.example' })
  expect(await outcome(foreign)).toBe('403 cross_site')
  const form = await fetch(member.base, { method: 'POST', headers: member.headers, body: 'page=spike' })
  expect(await outcome(form)).toBe('403 cross_site')
  return first
}

const asGuest = async (guest: Seat, stranger: Seat, memberComment: CommentView) => {
  const seen = await listing(guest, 'spike')
  expect(seen.reader).toEqual({ kind: 'guest', name: null, canComment: true, canResolve: false })
  expect(seen.comments).toMatchObject([{ id: memberComment.id, mine: false }])

  expect(await outcome(await send(guest, 'POST', '', draft('spike', 'Hi')))).toBe('400 name_required')
  const keyless: Seat = { base: guest.base, headers: {} }
  expect(await outcome(await send(keyless, 'POST', '', draft('spike', 'Hi', null, 'Ana')))).toBe('400 key_required')
  const reply = await post(guest, draft('spike', 'Yes, that is the one.', memberComment.id, 'Ana'))
  expect(reply).toMatchObject({ author: 'Ana', authorKind: 'guest', mine: true, parentId: memberComment.id })
  const own = await post(guest, draft('spike', 'One more thing.', null, 'Ana'))

  // A guest never resolves, never deletes someone else's words, and never leaves the page the link opens.
  const resolve = await send(guest, 'PATCH', `/${memberComment.id}`, { status: 'resolved' })
  expect(await outcome(resolve)).toBe('403 only_the_team_resolves')
  expect(await outcome(await send(guest, 'DELETE', `/${memberComment.id}`))).toBe('403 not_yours')
  expect(await outcome(await send(guest, 'GET', '?page=other'))).toBe('404 not_found')
  expect(await outcome(await send(guest, 'POST', '', draft('other', 'x', null, 'Ana')))).toBe('404 not_found')
  // Another browser on the same link is another guest.
  expect(await outcome(await send(stranger, 'DELETE', `/${own.id}`))).toBe('403 not_yours')
  expect((await listing(stranger, 'spike')).comments.every((comment) => !comment.mine)).toBe(true)
  expect(await outcome(await send(guest, 'DELETE', `/${own.id}`))).toBe('204')
  return reply
}

const asAgent = async (to: Instance, member: Seat, thread: CommentView) => {
  expect((await fetch(`${to.url}/api/comments`)).status).toBe(401)
  const markdown = await read(to, '/api/comments?page=spike', 'text/markdown')
  expect(markdown).toContain('## Spike & film (spike)')
  expect(markdown).toContain(`thread \`${thread.id}\``)
  expect(markdown).toContain('"Spike" [open]')
  expect(markdown).toContain('**Ana (guest)**')
  expect(await read(to, '/api/comments.md?page=spike', '*/*')).toBe(markdown)
  const all = decodeThreads(await call(to, { method: 'GET', path: '/api/comments?status=all' }))
  expect(all.threads.map((item) => item.page).toSorted()).toEqual(['spike', 'spike/notes', 'spike/sub/page.html'])
  const inside = await call(to, { method: 'GET', path: '/api/comments?page=spike%2Fnotes' })
  expect(decodeThreads(inside).threads.map((item) => item.page)).toEqual(['spike/notes'])

  const path = `/api/comments/${thread.id}/replies`
  const answer = decodeComment(await call(to, { method: 'POST', path, json: { body: 'Fixed in the next publish.' } }))
  expect(answer).toMatchObject({ author: 'agent', authorKind: 'agent', parentId: thread.id, mine: false })
  const signed = decodeComment(await call(to, { method: 'POST', path, json: { body: 'Done.', name: 'codex-1' } }))
  expect(signed.author).toBe('codex-1')
  // Agents answer; they have no route to resolve.
  const resolve = await fetch(`${to.url}/api/comments/${thread.id}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${to.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'resolved' }),
  })
  expect(resolve.status).toBe(404)
  const seen = (await listing(member, 'spike')).comments
  expect(seen.filter((comment) => comment.authorKind === 'agent').map((comment) => comment.body)).toEqual([
    'Fixed in the next publish.',
    'Done.',
  ])
}

const deciding = async (to: Instance, member: Seat, guest: Seat, thread: CommentView, guestReply: CommentView) => {
  // A member deletes only their own words, and not once someone answered them.
  expect(await outcome(await send(member, 'DELETE', `/${guestReply.id}`))).toBe('403 not_yours')
  expect(await outcome(await send(member, 'DELETE', `/${thread.id}`))).toBe('409 has_replies')
  expect(await outcome(await send(member, 'PATCH', `/${guestReply.id}`, { status: 'resolved' }))).toBe(
    '400 status_is_a_threads',
  )
  const resolved = decodeComment(await (await send(member, 'PATCH', `/${thread.id}`, { status: 'resolved' })).json())
  expect(resolved).toMatchObject({ status: 'resolved', statusBy: 'Mira' })
  const open = decodeThreads(await call(to, { method: 'GET', path: '/api/comments?page=spike' }))
  expect(open.threads.map((item) => item.root.id)).not.toContain(thread.id)
  expect(await read(to, '/api/comments?page=spike&status=all', 'text/markdown')).toContain('[resolved by Mira]')
  const since = new Date(Date.now() + 60_000).toISOString()
  const later = await call(to, { method: 'GET', path: `/api/comments?status=all&since=${encodeURIComponent(since)}` })
  expect(decodeThreads(later).threads).toEqual([])
  expect((await listing(guest, 'spike')).comments.find((comment) => comment.id === thread.id)?.status).toBe('resolved')
  const reopened = await send(member, 'PATCH', `/${thread.id}`, { status: 'open' })
  expect(decodeComment(await reopened.json())).toMatchObject({ status: 'open', statusBy: null })
}

/** A share link takes a bounded number of guest comments in a window, then answers 429. */
const flooding = async (guest: Seat) => {
  const answers: number[] = []
  for (let index = 0; index <= guestPostsPerWindow && answers.at(-1) !== 429; index++) {
    answers.push((await send(guest, 'POST', '', draft('spike', `Flood ${index}`, null, 'Ana'))).status)
  }
  expect(answers.at(-1)).toBe(429)
  expect(answers.filter((status) => status === 201).length).toBeLessThan(guestPostsPerWindow)
}

export const commenting = async (to: Instance, token: Readonly<Record<string, string>>, link: string) => {
  const member: Seat = { base: `${to.url}/spike/_crit/comments`, headers: token }
  const guest: Seat = { base: `${link}_crit/comments`, headers: { 'x-crit-key': 'guest-browser-key-0001' } }
  const stranger: Seat = { base: guest.base, headers: { 'x-crit-key': 'other-browser-key-0002' } }
  const thread = await asMember(member)
  const guestReply = await asGuest(guest, stranger, thread)
  await asAgent(to, member, thread)
  await deciding(to, member, guest, thread, guestReply)
  await flooding(guest)
  // The comments script is served to everyone, and a member's sign-in is no key to the agents' API.
  const script = await fetch(`${to.url}/lib/comments.js`)
  expect(script.headers.get('content-type')).toContain('text/javascript')
  expect(await script.text()).toContain('crit: built from client/comments.ts')
  expect((await fetch(`${to.url}/api/comments.md?page=spike`, { headers: token })).status).toBe(401)
  // Without the member's token the page's comments are as private as the page.
  expect((await fetch(`${member.base}?page=spike`)).status).toBe(403)
  return guest
}

/** A public page takes guests' comments at its own address; the limit there is counted for the page. */
export const onPublicPage = async (to: Instance, token: Readonly<Record<string, string>>) => {
  const member: Seat = { base: `${to.url}/spike/_crit/comments`, headers: token }
  const visitor: Seat = {
    base: `${to.url}/p/spike/_crit/comments`,
    headers: { 'x-crit-key': 'public-browser-key-0003' },
  }
  const seen = await listing(visitor, 'spike')
  expect(seen.reader).toEqual({ kind: 'guest', name: null, canComment: true, canResolve: false })
  expect(seen.comments.length).toBeGreaterThan(0)
  const written = await post(visitor, draft('spike', 'Seen from the public page.', null, 'Bo'))
  expect(written).toMatchObject({ author: 'Bo', authorKind: 'guest', mine: true })
  expect((await listing(member, 'spike')).comments.map((comment) => comment.id)).toContain(written.id)
  const resolve = await send(visitor, 'PATCH', `/${written.id}`, { status: 'resolved' })
  expect(await outcome(resolve)).toBe('403 only_the_team_resolves')
  expect(await outcome(await send(visitor, 'GET', '?page=other'))).toBe('404 not_found')
  expect(await outcome(await send(visitor, 'DELETE', `/${written.id}`))).toBe('204')
  // A page that is not public has no comments in the open.
  expect((await fetch(`${to.url}/p/other/_crit/comments?page=other`)).status).toBe(404)
}

/** After the link is revoked and the page removed: the link's comments are gone with it, the agents still read them. */
export const afterRemoval = async (to: Instance, guest: Seat) => {
  expect((await send(guest, 'GET', '?page=spike')).status).toBe(404)
  expect((await send(guest, 'POST', '', draft('spike', 'Too late', null, 'Ana'))).status).toBe(404)
  expect(await read(to, '/api/comments?page=spike&status=all', 'text/markdown')).toContain('this page was taken down')
}

/** `outsiders: 'view'`: a guest reads the threads and writes nothing. */
export const viewOnly = async (link: string) => {
  const guest: Seat = { base: `${link}_crit/comments`, headers: { 'x-crit-key': 'guest-browser-key-0001' } }
  const seen = await listing(guest, 'spike')
  expect(seen.reader).toEqual({ kind: 'guest', name: null, canComment: false, canResolve: false })
  expect(await outcome(await send(guest, 'POST', '', draft('spike', 'Hi', null, 'Ana')))).toBe('403 comments_are_off')
}
