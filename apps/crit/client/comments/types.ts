import type { Place } from './place.ts'
import type { Box } from './popover.ts'

export type Status = 'open' | 'resolved'

export interface PageComment {
  readonly id: string
  readonly anchor: string
  readonly anchorText: string
  readonly author: string
  readonly authorKind: 'member' | 'guest' | 'agent'
  readonly body: string
  readonly createdAt: string
  /** The comment this one replies to; null for a thread's first comment. */
  readonly parentId: string | null
  /** Meaningful on a thread's first comment. */
  readonly status: Status
  readonly statusBy: string | null
  /** The reader wrote it, so they may delete it. */
  readonly mine: boolean
}

/** What the server lets this reader do. Until it answers, the reader may only look. */
export interface Reader {
  readonly kind: 'member' | 'guest'
  readonly canComment: boolean
  readonly canResolve: boolean
}

export interface Anchor {
  /** Where the 💬 button lives and what the panel scrolls to. */
  readonly node: HTMLElement
  /** The element whose text is the anchor (differs from `node` for table rows and <summary>). */
  readonly source: HTMLElement
  readonly text: string
}

export interface Selected {
  readonly hostId: string
  readonly quote: string
  readonly rect: DOMRect
}

export interface State {
  readonly place: Place
  /** Which elements take comments: the script tag's `data-crit-selector`, or the default. */
  readonly selector: string
  readonly anchors: Map<string, Anchor>
  readonly owners: Map<Element, string>
  readonly buttons: Map<string, HTMLButtonElement>
  readonly marked: Set<string>
  readonly fab: HTMLButtonElement
  readonly selectButton: HTMLButtonElement
  /** Glow for commented diagram parts, as CSS rules: Pele rewrites its SVG elements' class attributes. */
  readonly glow: HTMLStyleElement
  reader: Reader
  comments: ReadonlyArray<PageComment>
  popover: HTMLElement | null
  panel: HTMLElement | null
  selected: Selected | null
  /** The open popover's anchor and where that is on the page (document coordinates). */
  popoverAt: { readonly id: string; readonly at: Box } | null
  showResolved: boolean
}

export const DEFAULT_SELECTOR =
  'main h1, main h2, main h3, main .card, main .rule, main tr, main li, main .diagram, main pre.mermaid, main details > summary, main p.lead, main [data-review-id]'
/** Pele diagram parts that can be commented on (all carry a `data-id`). */
export const PART = '.pele-node, .pele-cluster, .pele-edge, .pele-edge-label, .pele-message'
/** An element that holds a diagram: crit's `<pre class="mermaid">` and `<div class="diagram">`. */
export const DIAGRAM = '.diagram, pre.mermaid'
export const QUOTE_MIN = 3
export const QUOTE_MAX = 280
