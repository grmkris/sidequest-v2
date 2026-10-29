import { TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser'

const accents: Readonly<Record<string, string>> = {
  a: 'á',
  e: 'ë',
  i: 'ï',
  o: 'ö',
  u: 'ü',
  A: 'Á',
  E: 'Ë',
  I: 'Ï',
  O: 'Ö',
  U: 'Ü',
}

export const pseudoMessage = (
  nodes: readonly MessageFormatElement[],
  locale: 'en-XA' | 'ar-XB',
): MessageFormatElement[] =>
  nodes.map((node) => {
    if (node.type === TYPE.literal && node.value.trim()) {
      const accented = node.value.replace(/[aeiouAEIOU]/g, (char) => accents[char] ?? char)
      const value =
        locale === 'en-XA'
          ? `⟦${accented}${'·'.repeat(Math.ceil(node.value.length * 0.35))}⟧`
          : `\u2067${accented}\u2069`
      return { ...node, value }
    }
    if (node.type === TYPE.tag) return { ...node, children: pseudoMessage(node.children, locale) }
    if (node.type === TYPE.select || node.type === TYPE.plural)
      return {
        ...node,
        options: Object.fromEntries(
          Object.entries(node.options).map(([key, option]) => [
            key,
            {
              ...option,
              value: pseudoMessage(option.value, locale),
            },
          ]),
        ),
      }
    return node
  })
