import { el } from './dom.ts'

/**
 * A tiny, safe formatter for comment bodies: `> quote` lines, `inline code`, **bold** and bare https links. It builds
 * DOM nodes with textContent only (no innerHTML), so nothing a commenter types can inject markup.
 */

const inlinePattern = /(`[^`]+`|\*\*[^*]+\*\*|https?:\/\/[^\s)]+)/g

const inlineNode = (part: string): Node => {
  if (part.startsWith('`') && part.endsWith('`') && part.length > 2)
    return el('code', { textContent: part.slice(1, -1) })
  if (part.startsWith('**') && part.endsWith('**') && part.length > 4)
    return el('strong', { textContent: part.slice(2, -2) })
  if (/^https?:\/\//.test(part))
    return el('a', { href: part, target: '_blank', rel: 'noopener noreferrer', textContent: part })
  return document.createTextNode(part)
}

const inline = (line: string): Node[] =>
  line
    .split(inlinePattern)
    .filter((part) => part !== '')
    .map(inlineNode)

const paragraph = (lines: ReadonlyArray<string>, quote: boolean): HTMLElement => {
  const node = el(quote ? 'blockquote' : 'p', { className: quote ? 'cm-bq' : 'cm-p' })
  lines.forEach((line, index) => {
    if (index > 0) node.appendChild(el('br'))
    for (const child of inline(line)) node.appendChild(child)
  })
  return node
}

/** Groups consecutive lines into quote / non-quote blocks; blank lines separate paragraphs. */
export const richText = (text: string): HTMLElement => {
  const root = el('div', { className: 'cm-body' })
  let block: string[] = []
  let quoting = false
  const flush = (): void => {
    if (block.length > 0) root.appendChild(paragraph(block, quoting))
    block = []
  }
  for (const raw of text.split('\n')) {
    const isQuote = /^\s*>/.test(raw)
    const line = isQuote ? raw.replace(/^\s*>\s?/, '') : raw
    if (raw.trim() === '' || isQuote !== quoting) flush()
    quoting = isQuote
    if (raw.trim() !== '') block.push(line)
  }
  flush()
  return root
}
