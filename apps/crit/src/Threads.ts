/** Pure thread assembly: comments are stored flat, each reply naming the comment it answers. */

interface Threadable {
  readonly id: string
  readonly parentId: string | null
  readonly createdAt: string
}

export interface Thread<C> {
  readonly root: C
  readonly replies: ReadonlyArray<C>
}

/** The thread's first comment. A reply whose parent is gone starts a thread of its own. */
const rootOf = <C extends Threadable>(byId: ReadonlyMap<string, C>, comment: C): C => {
  let current = comment
  for (let hops = 0; current.parentId !== null && hops < 50; hops++) {
    const parent = byId.get(current.parentId)
    if (parent === undefined) break
    current = parent
  }
  return current
}

/** Threads in the order their first comments were written, each with its replies oldest first. */
export const threadsOf = <C extends Threadable>(comments: ReadonlyArray<C>): ReadonlyArray<Thread<C>> => {
  const ordered = comments.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  const byId = new Map(ordered.map((comment) => [comment.id, comment]))
  const replies = new Map<string, C[]>()
  for (const comment of ordered) {
    const root = rootOf(byId, comment)
    const list = replies.get(root.id) ?? []
    if (root.id !== comment.id) list.push(comment)
    replies.set(root.id, list)
  }
  return ordered.flatMap((comment) => {
    const own = replies.get(comment.id)
    return own !== undefined && rootOf(byId, comment).id === comment.id ? [{ root: comment, replies: own }] : []
  })
}
