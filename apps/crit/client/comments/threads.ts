import type { PageComment, State } from './types.ts'

// ---------- threads ----------

const byId = (state: State): ReadonlyMap<string, PageComment> => new Map(state.comments.map((c) => [c.id, c]))

/** The thread's first comment. A reply whose parent is gone counts as a root. */
const rootOf = (state: State, comment: PageComment): PageComment => {
  const index = byId(state)
  let current = comment
  for (let hops = 0; current.parentId && hops < 50; hops++) {
    const parent = index.get(current.parentId)
    if (!parent) break
    current = parent
  }
  return current
}

export const isRoot = (state: State, comment: PageComment): boolean => rootOf(state, comment).id === comment.id

export const isOpen = (state: State, comment: PageComment): boolean => rootOf(state, comment).status === 'open'

export const repliesTo = (state: State, id: string): ReadonlyArray<PageComment> =>
  state.comments.filter((c) => c.parentId === id)

export const rootsFor = (state: State, anchorId: string): ReadonlyArray<PageComment> =>
  state.comments.filter((c) => c.anchor === anchorId && isRoot(state, c))

const matches = (anchorId: string, comment: PageComment): boolean =>
  comment.anchor === anchorId || comment.anchor.startsWith(`${anchorId}/`)

/** Badge: open threads on this element and its diagram parts / quotes. */
export const openThreadCount = (state: State, anchorId: string): number =>
  state.comments.filter((c) => matches(anchorId, c) && isRoot(state, c) && c.status === 'open').length

export const anyThread = (state: State, anchorId: string): boolean => state.comments.some((c) => matches(anchorId, c))
