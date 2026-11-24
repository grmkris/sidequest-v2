import { DIAGRAM, PART, type State } from './types.ts'
import { el, escapeRegExp, svgText } from './dom.ts'
import { isOpen } from './threads.ts'
import { hash } from './place.ts'

// ---------- diagram parts ----------

const partKind = (part: Element): string => {
  if (part.classList.contains('pele-cluster')) return 'group'
  return part.classList.contains('pele-node') ? 'node' : 'arrow'
}

const partLabel = (part: Element): string => {
  const id = part.getAttribute('data-id') ?? ''
  if (part.classList.contains('pele-cluster')) return svgText(part.querySelector('text') ?? part).slice(0, 120)
  if (part.classList.contains('pele-node')) return svgText(part)
  // Arrows and sequence messages: the label is a sibling element sharing the data-id.
  const label = part.closest('svg')?.querySelector(`.pele-edge-label[data-id="${CSS.escape(id)}"]`)
  return label ? svgText(label) : id
}

const partAnchorId = (diagramId: string, part: Element): string =>
  `${diagramId}/n/${part.getAttribute('data-id') ?? ''}:${hash(partLabel(part))}`

export const registerPart = (state: State, diagramId: string, part: Element): string => {
  const id = partAnchorId(diagramId, part)
  const diagram = state.anchors.get(diagramId)
  if (diagram && !state.anchors.has(id)) {
    state.anchors.set(id, {
      node: diagram.node,
      source: diagram.source,
      text: `${partKind(part)}: ${partLabel(part)}`.slice(0, 280),
    })
  }
  return id
}

/** Glow on parts with comments (CSS rules keyed by data-id); also registers them so the panel doesn't list them as orphans. */
export const markParts = (state: State): void => {
  const commented = new Set(state.comments.map((c) => c.anchor))
  const live = new Set(state.comments.filter((c) => isOpen(state, c)).map((c) => c.anchor))
  const rules: string[] = []
  // Collect first: registerPart adds entries to state.anchors while we loop.
  const diagrams = [...state.anchors].filter(([, anchor]) => anchor.source.matches(DIAGRAM))
  for (const [diagramId, anchor] of diagrams) {
    for (const part of anchor.source.querySelectorAll(PART)) {
      if (!commented.has(partAnchorId(diagramId, part))) continue
      registerPart(state, diagramId, part)
      if (!live.has(partAnchorId(diagramId, part))) continue
      const key = CSS.escape(anchor.source.dataset['cmDiagram'] ?? '')
      rules.push(`[data-cm-diagram="${key}"] [data-id="${CSS.escape(part.getAttribute('data-id') ?? '')}"]`)
    }
  }
  state.glow.textContent =
    rules.length > 0
      ? `${rules.join(',\n')} { filter: drop-shadow(0 0 3px var(--accent, #1257d6)) drop-shadow(0 0 2px var(--accent, #1257d6)); }`
      : ''
}

// ---------- text quotes ----------

const textNodesOf = (root: Element): Text[] => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest('.cm-btn, .cm-mark, svg, script, style')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  })
  const nodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node instanceof Text) nodes.push(node)
  return nodes
}

/** Wraps the first whitespace-insensitive match of `quote` inside `root` in <mark>s; returns false if not found. */
const wrapQuote = (root: Element, quote: string, anchorId: string): boolean => {
  const nodes = textNodesOf(root)
  const match = new RegExp(quote.split(/\s+/).map(escapeRegExp).join('\\s+')).exec(nodes.map((n) => n.data).join(''))
  if (!match) return false
  const start = match.index
  const end = start + match[0].length
  let offset = 0
  for (const node of nodes) {
    const from = offset
    offset += node.data.length
    if (offset <= start || from >= end) continue
    const range = document.createRange()
    range.setStart(node, Math.max(start, from) - from)
    range.setEnd(node, Math.min(end, offset) - from)
    const mark = el('mark', { className: 'cm-mark' })
    mark.dataset['anchor'] = anchorId
    range.surroundContents(mark)
  }
  return true
}

export const markQuotes = (state: State): void => {
  for (const comment of state.comments) {
    const at = comment.anchor.indexOf('/q/')
    const host = at > 0 ? state.anchors.get(comment.anchor.slice(0, at)) : undefined
    if (!host || state.marked.has(comment.anchor)) continue
    if (wrapQuote(host.source, comment.anchorText, comment.anchor)) {
      state.marked.add(comment.anchor)
      state.anchors.set(comment.anchor, { node: host.node, source: host.source, text: comment.anchorText })
    }
  }
}
