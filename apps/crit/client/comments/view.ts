import { deleteComment, type Draft, fetchComments, guestName, patchStatus, postComment, rememberName } from './api.ts'
import { button, el, link, messageOf } from './dom.ts'
import { markParts, markQuotes } from './marks.ts'
import { hash } from './place.ts'
import { type Box, placePopover } from './popover.ts'
import { richText } from './richtext.ts'
import { anyThread, isRoot, openThreadCount, repliesTo, rootsFor } from './threads.ts'
import { type PageComment, QUOTE_MAX, QUOTE_MIN, type Selected, type State, type Status } from './types.ts'

const ownerIdOf = (state: State, start: Element): string | null => {
  for (let node: Element | null = start; node; node = node.parentElement) {
    const id = state.owners.get(node)
    if (id) return id
  }
  return null
}

const readSelection = (state: State): Selected | null => {
  const selection = getSelection()
  if (!state.reader.canComment || !selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const quote = selection.toString().replaceAll(/\s+/gu, ' ').trim()
  if (quote.length < QUOTE_MIN || quote.length > QUOTE_MAX) return null
  const range = selection.getRangeAt(0)
  const container = range.commonAncestorContainer
  const start = container instanceof Element ? container : container.parentElement
  if (!start || start.closest('svg, .cm-pop, .cm-panel, .cm-sel, .cm-btn')) return null
  const hostId = ownerIdOf(state, start)
  return hostId ? { hostId, quote, rect: range.getBoundingClientRect() } : null
}

export const showSelectButton = (state: State): void => {
  state.selected = readSelection(state)
  const { selectButton } = state
  if (!state.selected) {
    selectButton.style.display = 'none'
    return
  }
  selectButton.style.display = 'block'
  selectButton.style.top = `${window.scrollY + state.selected.rect.bottom + 6}px`
  selectButton.style.left = `${window.scrollX + state.selected.rect.right - selectButton.offsetWidth}px`
}

export const commentOnSelection = (state: State): void => {
  const selected = state.selected
  const host = selected ? state.anchors.get(selected.hostId) : undefined
  if (!selected || !host) return
  const id = `${selected.hostId}/q/${hash(selected.quote)}`
  state.anchors.set(id, { node: host.node, source: host.source, text: selected.quote })
  state.selectButton.style.display = 'none'
  // Measure again: the page may have scrolled since the selection was made (rects are viewport-relative).
  const live = getSelection()
  openPopover(state, id, live && live.rangeCount > 0 ? live.getRangeAt(0).getBoundingClientRect() : selected.rect)
}

// ---------- rendering ----------

export const render = (state: State): void => {
  markParts(state)
  markQuotes(state)
  for (const [id, btn] of state.buttons) {
    const count = openThreadCount(state, id)
    const any = anyThread(state, id)
    btn.classList.toggle('cm-has', count > 0)
    btn.classList.toggle('cm-done', count === 0 && any)
    btn.textContent = count > 0 ? String(count) : any ? '✓' : '💬'
    // A reader who may only look gets a button where there is something to read.
    btn.hidden = !state.reader.canComment && !any
  }
  const open = state.comments.filter((c) => isRoot(state, c) && c.status === 'open').length
  state.fab.textContent = `💬 Comments (${open} open)`
}

export const closePopover = (state: State): void => {
  state.popover?.remove()
  state.popover = null
  state.popoverAt = null
}

export const closePanel = (state: State): void => {
  state.panel?.remove()
  state.panel = null
}

/** A short message at the bottom of the page, for a failure that has no form to show it in. */
const toast = (message: string): void => {
  const node = el('div', { className: 'cm-toast', textContent: message })
  document.body.appendChild(node)
  window.setTimeout(() => node.remove(), 5000)
}

const reload = async (state: State): Promise<void> => {
  const reopen = state.popoverAt
  const panelWasOpen = state.panel !== null
  try {
    const { reader, comments } = await fetchComments(state)
    state.reader = reader
    state.comments = comments
  } catch (failure) {
    toast(`Comments could not load: ${messageOf(failure)}`)
  }
  render(state)
  if (reopen) openAt(state, reopen.id, reopen.at)
  if (panelWasOpen) {
    closePanel(state)
    openPanel(state)
  }
}

/** Reload, then redraw whatever was open so the reader keeps their place. */
const failed =
  (prefix: string) =>
  (error: unknown): void =>
    toast(`${prefix}: ${messageOf(error)}`)

/** Reload, then redraw whatever was open so the reader keeps their place. */
export const refresh = (state: State): void => {
  reload(state).catch(failed('Could not load comments'))
}

const setStatus = (state: State, id: string, status: Status): void => {
  patchStatus(state, id, status).then(() => refresh(state), failed('Could not update'))
}

/** Resolving is the team's: a guest sees the state, never the buttons. */
const statusBar = (state: State, root: PageComment): HTMLElement | null => {
  const { canResolve } = state.reader
  if (root.status === 'open') {
    if (!canResolve) return null
    return el(
      'div',
      { className: 'cm-status' },
      button('Resolve', 'cm-link', () => setStatus(state, root.id, 'resolved')),
    )
  }
  const label = `✓ resolved${root.statusBy ? ` by ${root.statusBy}` : ''}`
  return el(
    'div',
    { className: 'cm-status' },
    el('span', { className: 'cm-chip cm-resolved', textContent: label }),
    canResolve ? button('Reopen', 'cm-link', () => setStatus(state, root.id, 'open')) : null,
  )
}

/** Deleting asks once more in place: the first press arms the button, the second deletes. */
const deleteButton = (state: State, id: string): HTMLButtonElement => {
  let armed = false
  const node = button('delete', 'cm-link cm-del', () => {
    if (!armed) {
      armed = true
      node.textContent = 'really delete?'
      return
    }
    deleteComment(state, id).then(() => refresh(state), failed('Could not delete'))
  })
  return node
}

const byline = (comment: PageComment): HTMLElement => {
  const when = new Date(comment.createdAt).toLocaleString()
  const tag =
    comment.authorKind === 'member' ? null : el('span', { className: 'cm-tag', textContent: comment.authorKind })
  return el('span', {}, document.createTextNode(`${comment.author} · ${when}`), tag)
}

const commentView = (state: State, comment: PageComment, depth: number): HTMLElement => {
  const replySlot = el('div')
  const reply = button('Reply', 'cm-link', () => {
    const target = { anchor: comment.anchor, anchorText: comment.anchorText, parentId: comment.id }
    replySlot.replaceChildren(form(state, target, 'Reply…'))
    replySlot.querySelector('textarea')?.focus()
  })
  const actions = el(
    'span',
    { className: 'cm-actions' },
    state.reader.canComment ? reply : null,
    comment.mine ? deleteButton(state, comment.id) : null,
  )
  const meta = el('div', { className: 'cm-meta' }, byline(comment), actions)
  const replies = repliesTo(state, comment.id).map((child) => commentView(state, child, depth + 1))
  return el(
    'div',
    { className: depth === 0 ? 'cm-item' : 'cm-item cm-reply' },
    meta,
    richText(comment.body),
    replySlot,
    ...replies,
  )
}

const threadView = (state: State, root: PageComment): HTMLElement =>
  el('div', { className: `cm-thread cm-thread-${root.status}` }, statusBar(state, root), commentView(state, root, 0))

/** Open threads first; resolved ones folded behind a toggle. */
const threadsView = (state: State, roots: ReadonlyArray<PageComment>): HTMLElement[] => {
  const open = roots.filter((r) => r.status === 'open').map((r) => threadView(state, r))
  const closed = roots.filter((r) => r.status !== 'open')
  if (closed.length === 0) return open
  const folded = el('div', { hidden: !state.showResolved }, ...closed.map((r) => threadView(state, r)))
  const label = (): string => `${state.showResolved ? 'Hide' : 'Show'} ${closed.length} resolved`
  const toggle = button(label(), 'cm-link cm-toggle', () => {
    state.showResolved = !state.showResolved
    folded.hidden = !state.showResolved
    toggle.textContent = label()
  })
  return [...open, toggle, folded]
}

type Target = Pick<Draft, 'anchor' | 'anchorText' | 'parentId'>

/** A guest signs with a name they type once; this browser remembers it. */
const nameField = (state: State): HTMLInputElement | null =>
  state.reader.kind === 'guest'
    ? el('input', { type: 'text', placeholder: 'Your name', maxLength: 60, value: guestName() })
    : null

const form = (state: State, target: Target, placeholder: string): HTMLElement => {
  const name = nameField(state)
  const body = el('textarea', { placeholder: `${placeholder} (⌘/Ctrl+Enter to send)`, maxLength: 4000 })
  const error = el('div', { className: 'cm-err' })
  const saved = (): void => {
    getSelection()?.removeAllRanges()
    refresh(state)
  }
  const notSaved = (failure: unknown): void => {
    error.textContent = `Could not save: ${messageOf(failure)}`
  }
  const submit = (): void => {
    const signed = name?.value.trim()
    if (signed === '') {
      error.textContent = 'Add your name first.'
      return
    }
    if (!body.value.trim()) {
      error.textContent = 'Write a comment first.'
      return
    }
    if (signed !== undefined) rememberName(signed)
    const draft: Draft = { ...target, body: body.value.trim(), ...(signed === undefined ? {} : { name: signed }) }
    postComment(state, draft).then(saved, notSaved)
  }
  body.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') submit()
  })
  const actions = el(
    'div',
    { className: 'cm-row' },
    button('Cancel', 'cm-ghost', () => closePopover(state)),
    button(target.parentId ? 'Reply' : 'Comment', '', submit),
  )
  return el('div', { className: 'cm-form' }, name, body, error, actions)
}

/** Puts the open popover where `placePopover` says, for where its anchor is on screen now. */
export const placeOpenPopover = (state: State): void => {
  const popover = state.popover
  const at = state.popoverAt?.at
  if (!popover || !at) return
  const visual = window.visualViewport
  const viewport = { width: document.documentElement.clientWidth, height: visual?.height ?? window.innerHeight }
  popover.style.maxHeight = ''
  const anchor = { ...at, top: at.top - window.scrollY, left: at.left - window.scrollX }
  const placed = placePopover(anchor, { width: popover.offsetWidth, height: popover.offsetHeight }, viewport)
  popover.classList.toggle('cm-sheet', placed.mode === 'sheet')
  popover.style.maxHeight = `${placed.maxHeight}px`
  if (placed.mode === 'sheet') {
    // Above the on-screen keyboard: the visual viewport ends where the keyboard begins.
    const covered = visual ? Math.max(0, window.innerHeight - visual.height - visual.offsetTop) : 0
    popover.style.top = ''
    popover.style.left = ''
    popover.style.bottom = `${covered}px`
    return
  }
  popover.style.bottom = ''
  popover.style.top = `${placed.top}px`
  popover.style.left = `${placed.left}px`
}

function openAt(state: State, id: string, at: Box): void {
  closePopover(state)
  const anchor = state.anchors.get(id)
  if (!anchor) return
  const title = anchor.text.length > 90 ? `${anchor.text.slice(0, 90)}…` : anchor.text
  const compose = state.reader.canComment
    ? form(state, { anchor: id, anchorText: anchor.text, parentId: null }, 'New comment…')
    : el('div', { className: 'cm-note', textContent: 'This link is for reading: comments are shown, not taken.' })
  const list = el('div', { className: 'cm-list' }, ...threadsView(state, rootsFor(state, id)))
  state.popover = el('div', { className: 'cm-pop' }, el('h4', { textContent: title }), list, compose)
  state.popoverAt = { id, at }
  document.body.appendChild(state.popover)
  placeOpenPopover(state)
  // A sheet can open over what it comments on: bring that up into the part of the screen left above it.
  const hidden = at.top + at.height - window.scrollY - state.popover.getBoundingClientRect().top
  if (state.popover.classList.contains('cm-sheet') && hidden > 0)
    window.scrollBy({ top: hidden + 12, behavior: 'smooth' })
}

/** Opens the threads on one anchor beside `rect`, which is where that anchor is on screen now. */
export function openPopover(state: State, id: string, rect: DOMRect): void {
  openAt(state, id, {
    top: rect.top + window.scrollY,
    left: rect.left + window.scrollX,
    width: rect.width,
    height: rect.height,
  })
}

const anchorGroup = (state: State, id: string, text: string, node: HTMLElement | null): HTMLElement[] => {
  const label = text.slice(0, 120)
  const head = node
    ? link(label, () => node.scrollIntoView({ behavior: 'smooth', block: 'center' }))
    : el('span', { textContent: label })
  return [el('div', { className: 'cm-quote' }, head), ...threadsView(state, rootsFor(state, id))]
}

export function openPanel(state: State): void {
  const known = [...state.anchors].filter(([id]) => rootsFor(state, id).length > 0)
  const roots = state.comments.filter((c) => isRoot(state, c))
  const orphanAnchors = [...new Set(roots.filter((c) => !state.anchors.has(c.anchor)).map((c) => c.anchor))]
  const open = roots.filter((c) => c.status === 'open').length
  const header = el(
    'div',
    { className: 'cm-row' },
    el('strong', { textContent: `Comments: ${open} open of ${roots.length} threads` }),
    button('Close', 'cm-ghost', () => closePanel(state)),
  )
  const grouped = known.flatMap(([id, anchor]) => anchorGroup(state, id, anchor.text, anchor.node))
  // The text a comment pointed at changed since: the comment stays, listed by the words it was about.
  const orphanTitle = orphanAnchors.length > 0 ? el('h3', { textContent: 'Comments on changed text' }) : null
  const orphaned = orphanAnchors.flatMap((id) =>
    anchorGroup(state, id, state.comments.find((c) => c.anchor === id)?.anchorText ?? id, null),
  )
  state.panel = el('aside', { className: 'cm-panel' }, header, ...grouped, orphanTitle, ...orphaned)
  document.body.appendChild(state.panel)
}
