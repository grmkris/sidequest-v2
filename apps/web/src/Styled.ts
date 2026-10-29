import { Html as FoldkitHtml } from 'foldkit'
import type { Html } from 'zyzz/runtime'

/** Foldkit attributes for an applied zyzz style: its classes, inline declarations
 * and recipe `data-*` attributes. Inline declarations need a `style-src-attr`
 * allowance in the edge CSP, so static styles are preferred. */
export const styled = <Message>(
  h: FoldkitHtml.HtmlBuilder<Message>,
  attributes: Html.Attributes,
): Array<FoldkitHtml.TextareaAttribute<Message>> => {
  const result: Array<FoldkitHtml.TextareaAttribute<Message>> = [FoldkitHtml.inertHtml.Class(attributes.class)]
  if (attributes.style !== undefined) result.push(h.Attribute('style', attributes.style))
  for (const [name, value] of Object.entries(attributes)) {
    if (name.startsWith('data-') && value !== undefined) result.push(h.DataAttribute(name.slice('data-'.length), value))
  }
  return result
}
