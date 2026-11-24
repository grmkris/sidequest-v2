import type { PageComment, Reader, State, Status } from './types.ts'

/** The reader's name and per-browser key, kept in this browser only. The key lets a guest delete their own comments. */
const NAME = 'crit.name'
const KEY = 'crit.key'

const stored = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const store = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Private windows may refuse storage: the name is then asked for again.
  }
}

export const guestName = (): string => stored(NAME) ?? ''
export const rememberName = (name: string): void => store(NAME, name)

const guestKey = (create: boolean): string | null => {
  const known = stored(KEY)
  if (known !== null || !create) return known
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const key = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  store(KEY, key)
  return key
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const stringOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)

const kindOf = (value: unknown): PageComment['authorKind'] =>
  value === 'guest' || value === 'agent' ? value : 'member'

const toComment = (value: unknown): PageComment | null => {
  if (!isRecord(value)) return null
  const { id, anchor, anchorText, author, body, createdAt } = value
  if (typeof id !== 'string' || typeof anchor !== 'string' || typeof anchorText !== 'string') return null
  if (typeof author !== 'string' || typeof body !== 'string' || typeof createdAt !== 'string') return null
  return {
    id,
    anchor,
    anchorText,
    author,
    authorKind: kindOf(value['authorKind']),
    body,
    createdAt,
    parentId: stringOrNull(value['parentId']),
    status: value['status'] === 'resolved' ? 'resolved' : 'open',
    statusBy: stringOrNull(value['statusBy']),
    mine: value['mine'] === true,
  }
}

const toReader = (value: unknown): Reader => ({
  kind: isRecord(value) && value['kind'] === 'member' ? 'member' : 'guest',
  canComment: isRecord(value) && value['canComment'] === true,
  canResolve: isRecord(value) && value['canResolve'] === true,
})

const problemOf = async (response: Response): Promise<string> => {
  const body: unknown = await response.json().catch(() => null)
  const code = isRecord(body) && typeof body['error'] === 'string' ? body['error'] : ''
  if (code === 'slow_down') return 'Too many comments on this page for now. Try again in a few minutes.'
  if (code === 'comments_are_off') return 'This page is for reading only.'
  if (code === 'has_replies') return 'Someone answered this comment, so it stays.'
  return code === '' ? `${response.status} ${response.statusText}`.trim() : code.replaceAll('_', ' ')
}

const signedOut = 'Your sign-in has ended. Reload the page to sign in again; what you typed is still here.'

/**
 * A member's request answered by the sign-in instead of crit: Access redirects an expired session to its login (seen
 * here as an unfollowed redirect), and crit itself answers a missing token with an HTML page.
 */
const lostSession = (response: Response): boolean =>
  response.type === 'opaqueredirect' ||
  (response.status >= 300 && response.status < 400) ||
  (!response.ok && (response.headers.get('content-type') ?? '').includes('text/html'))

const send = async (state: State, path: string, init: RequestInit, write: boolean): Promise<unknown> => {
  const key = state.place.guest ? guestKey(write) : null
  const response = await fetch(`${state.place.api}${path}`, {
    ...init,
    // A member's expired session must show as such, not as a failed fetch to another site's login page.
    redirect: state.place.guest ? 'follow' : 'manual',
    headers: {
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(key === null ? {} : { 'x-crit-key': key }),
    },
  })
  if (!state.place.guest && lostSession(response)) throw new Error(signedOut)
  if (!response.ok) throw new Error(await problemOf(response))
  return response.status === 204 ? null : response.json()
}

export const fetchComments = async (
  state: State,
): Promise<{ readonly reader: Reader; readonly comments: ReadonlyArray<PageComment> }> => {
  const body = await send(state, `?page=${encodeURIComponent(state.place.page)}`, {}, false)
  const list = isRecord(body) && Array.isArray(body['comments']) ? body['comments'] : []
  return {
    reader: toReader(isRecord(body) ? body['reader'] : null),
    comments: list.map(toComment).filter((comment): comment is PageComment => comment !== null),
  }
}

export interface Draft {
  readonly anchor: string
  readonly anchorText: string
  readonly parentId: string | null
  readonly body: string
  /** A guest's name; members are named by Cloudflare Access. */
  readonly name?: string
}

export const postComment = (state: State, draft: Draft): Promise<unknown> =>
  send(state, '', { method: 'POST', body: JSON.stringify({ page: state.place.page, ...draft }) }, true)

export const patchStatus = (state: State, id: string, status: Status): Promise<unknown> =>
  send(state, `/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ status }) }, true)

export const deleteComment = (state: State, id: string): Promise<unknown> =>
  send(state, `/${encodeURIComponent(id)}`, { method: 'DELETE' }, true)
