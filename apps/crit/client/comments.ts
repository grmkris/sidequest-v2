/**
 * Comments on a crit page. `bun run build:client` compiles this file to src/lib/comments.js, which the Worker serves
 * at /lib/comments.js. A page opts in with `<script src="/lib/comments.js" defer></script>`, after `/lib/pele.js` and
 * `/lib/diagrams.js` when it has diagrams.
 *
 * It works wherever the page is open, with the comments under the page's own address (`…/_crit/comments`): signed in
 * at `/<slug>/…` (signed with the email Cloudflare Access admitted), in public at `/p/<slug>/…` and by a share link
 * at `/s/<token>/<slug>/…` (a guest types a name once, and the deploy's `outsiders` setting says whether guests
 * write, only read, or see no threads).
 *
 * Three granularities, one storage:
 * - Elements: every heading, card, table row, list item and diagram gets a 💬 on hover. Anchor:
 *   `<section>/<kind>/<text hash>`. An element inside another commentable element doesn't get its own. Another set of
 *   elements: `<script src="/lib/comments.js" data-crit-selector="article h2, article p" defer>`.
 * - Diagram parts: click a node, group, arrow or sequence message in a pele diagram. Anchor:
 *   `<diagram anchor>/n/<pele data-id>:<label hash>`. Commented parts glow.
 * - Selected text: select words inside any element and press "💬 Comment on selection". Anchor:
 *   `<element anchor>/q/<quote hash>`; the quote is stored as the anchor text and highlighted on load.
 * Threads: every comment has Reply (nested, any depth); the team resolves and reopens a thread; resolved threads fold
 * away and badges count open threads only. If the text a comment points to changes, the comment moves to "Comments on
 * changed text" in the panel. Agents read and answer with `bun run comments` (scripts/comments.ts).
 */
import { collectAnchors, ownersOf } from './comments/anchors.ts'
import { el } from './comments/dom.ts'
import { registerPart } from './comments/marks.ts'
import { placeOf } from './comments/place.ts'
import { css } from './comments/style.ts'
import { DEFAULT_SELECTOR, DIAGRAM, PART, type State } from './comments/types.ts'
import {
  closePanel,
  closePopover,
  commentOnSelection,
  openPanel,
  openPopover,
  placeOpenPopover,
  refresh,
  render,
  showSelectButton,
} from './comments/view.ts'

/** Read while the script runs: `document.currentScript` is gone by the time the page has loaded. */
const script = document.currentScript
const selector = (script instanceof HTMLScriptElement ? script.dataset['critSelector'] : undefined) || DEFAULT_SELECTOR

const attachButtons = (state: State): void => {
  for (const [id, { node }] of state.anchors) {
    node.classList.add('cm-host')
    const btn = el('button', { className: 'cm-btn', type: 'button', title: 'Comment', textContent: '💬' })
    btn.addEventListener('click', (event) => {
      event.stopPropagation()
      // Beside the element itself, so it stays readable; a tall one would push the popover off, so then its button.
      const host = node.getBoundingClientRect()
      openPopover(state, id, host.height <= window.innerHeight * 0.6 ? host : btn.getBoundingClientRect())
    })
    node.appendChild(btn)
    state.buttons.set(id, btn)
  }
}

/** Click (not drag: pele pans on drag) a diagram part to comment on it. */
const watchDiagram = (state: State, diagramId: string, host: HTMLElement): void => {
  let down: { readonly x: number; readonly y: number } | null = null
  host.addEventListener('pointerdown', (event) => {
    down = { x: event.clientX, y: event.clientY }
  })
  host.addEventListener('click', (event) => {
    const dragged = down !== null && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5
    const part = event.target instanceof Element ? event.target.closest(PART) : null
    if (dragged || !part || !state.reader.canComment) return
    event.stopPropagation()
    openPopover(state, registerPart(state, diagramId, part), part.getBoundingClientRect())
  })
}

const openMark = (state: State, target: EventTarget | null): boolean => {
  const mark = target instanceof Element ? target.closest('.cm-mark') : null
  const id = mark instanceof HTMLElement ? mark.dataset['anchor'] : undefined
  if (!mark || !id) return false
  openPopover(state, id, mark.getBoundingClientRect())
  return true
}

const listenGlobally = (state: State): void => {
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    closePopover(state)
    closePanel(state)
  })
  document.addEventListener('click', (event) => {
    if (openMark(state, event.target)) return
    const target = event.target
    const onButton = target instanceof HTMLElement && target.matches('.cm-btn, .cm-sel')
    if (state.popover && target instanceof Node && !state.popover.contains(target) && !onButton) closePopover(state)
  })
  const replace = (): void => placeOpenPopover(state)
  window.addEventListener('scroll', replace, { passive: true })
  window.addEventListener('resize', replace)
  window.visualViewport?.addEventListener('resize', replace)
  window.visualViewport?.addEventListener('scroll', replace)
  let pending = 0
  document.addEventListener('selectionchange', () => {
    window.clearTimeout(pending)
    pending = window.setTimeout(() => showSelectButton(state), 200)
  })
  // Keep the selection alive while pressing the button.
  state.selectButton.addEventListener('pointerdown', (event) => event.preventDefault())
  state.selectButton.addEventListener('click', () => commentOnSelection(state))
  state.fab.addEventListener('click', () => (state.panel ? closePanel(state) : openPanel(state)))
}

const start = (): void => {
  const place = placeOf(location.pathname)
  if (place === undefined) return
  document.head.appendChild(el('style', { textContent: css }))
  const anchors = collectAnchors(selector)
  const state: State = {
    place,
    selector,
    anchors,
    owners: ownersOf(anchors),
    buttons: new Map(),
    marked: new Set(),
    fab: el('button', { className: 'cm-fab', type: 'button' }),
    selectButton: el('button', { className: 'cm-sel', type: 'button', textContent: '💬 Comment on selection' }),
    glow: el('style'),
    // Until the server says who is reading, nobody may write.
    reader: { kind: place.guest ? 'guest' : 'member', canComment: false, canResolve: false },
    comments: [],
    popover: null,
    panel: null,
    selected: null,
    popoverAt: null,
    showResolved: false,
  }
  document.body.appendChild(state.fab)
  document.body.appendChild(state.selectButton)
  document.head.appendChild(state.glow)
  attachButtons(state)
  let diagramIndex = 0
  for (const [id, { source }] of anchors) {
    if (!source.matches(DIAGRAM)) continue
    source.classList.add('cm-diagram')
    source.dataset['cmDiagram'] = String(diagramIndex++)
    watchDiagram(state, id, source)
  }
  listenGlobally(state)
  render(state)
  refresh(state)
}

// Once the page is parsed. With `defer` that is now, and /lib/diagrams.js (loaded before this script) has already drawn.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
else start()
