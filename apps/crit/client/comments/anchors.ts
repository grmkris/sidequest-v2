import { textOf } from './dom.ts'
import { anchorFor, sectionSlug } from './place.ts'
import { type Anchor, DIAGRAM } from './types.ts'

// ---------- anchors: which elements can be commented on ----------

const isSection = (node: Element): boolean => node.tagName === 'H1' || node.tagName === 'H2'

/**
 * An element inside another commentable element doesn't get its own button, and neither does a table's header row.
 * A diagram always does, wherever it sits: its parts are commented on through it.
 */
const isSkipped = (node: Element, selector: string): boolean =>
  (!node.matches(DIAGRAM) && node.parentElement?.closest(selector) != null) ||
  (node.tagName === 'TR' && node.querySelector('th') !== null)

/** A diagram is named by its source, which the page script keeps in `data-crit-source` before pele redraws it. */
const labelOf = (node: HTMLElement): string =>
  node.matches(DIAGRAM) ? `diagram:${(node.dataset['critSource'] ?? textOf(node)).slice(0, 200)}` : textOf(node)

const kindOf = (node: Element): string => {
  const first = node.classList.item(0)
  return first ? `${node.tagName.toLowerCase()}.${first}` : node.tagName.toLowerCase()
}

/** Where the button goes: a button can't live directly in a <tr>, and clicking inside a <summary> toggles <details>. */
const hostOf = (node: HTMLElement): HTMLElement => {
  const target = node.tagName === 'SUMMARY' ? node.parentElement : node.tagName === 'TR' ? node.lastElementChild : node
  return target instanceof HTMLElement ? target : node
}

export const collectAnchors = (selector: string): Map<string, Anchor> => {
  const anchors = new Map<string, Anchor>()
  let section = 'top'
  for (const node of document.querySelectorAll<HTMLElement>(selector)) {
    if (isSection(node)) section = sectionSlug(textOf(node)) || section
    const label = labelOf(node)
    if (isSkipped(node, selector) || !label) continue
    const named = { reviewId: node.dataset['reviewId'], section, kind: kindOf(node), label }
    const id = anchorFor(named, (taken) => anchors.has(taken))
    const text = node.matches(DIAGRAM) ? 'Diagram' : textOf(node).slice(0, 160)
    anchors.set(id, { node: hostOf(node), source: node, text })
  }
  return anchors
}

export const ownersOf = (anchors: ReadonlyMap<string, Anchor>): Map<Element, string> => {
  const owners = new Map<Element, string>()
  for (const [id, anchor] of anchors) {
    owners.set(anchor.source, id)
    owners.set(anchor.node, id)
  }
  return owners
}
