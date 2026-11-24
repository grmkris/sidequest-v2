// ---------- small DOM helpers ----------

export const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: ReadonlyArray<Node | null>
): HTMLElementTagNameMap[K] => {
  const node = Object.assign(document.createElement(tag), props)
  // appendChild, not append: the repo also loads Cloudflare's Worker types, whose HTMLRewriter `Element.append` shadows the DOM one.
  for (const child of children) if (child !== null) node.appendChild(child)
  return node
}

export const button = (label: string, className: string, onClick: () => void): HTMLButtonElement => {
  const node = el('button', { type: 'button', className, textContent: label })
  node.addEventListener('click', onClick)
  return node
}

export const link = (label: string, onClick: () => void): HTMLAnchorElement => {
  const node = el('a', { textContent: label, href: '#' })
  node.addEventListener('click', (event) => {
    event.preventDefault()
    onClick()
  })
  return node
}

export const textOf = (node: Element): string =>
  (node instanceof HTMLElement ? node.innerText : (node.textContent ?? '')).replace(/\s+/g, ' ').trim()

/** SVG labels are split into <tspan> lines with no whitespace between them. */
export const svgText = (node: Element): string => {
  const lines = [...node.querySelectorAll('tspan')].map((line) => line.textContent ?? '')
  return (lines.length > 0 ? lines.join(' ') : (node.textContent ?? '')).replace(/\s+/g, ' ').trim()
}

export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
