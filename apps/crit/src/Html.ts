/** Text made safe to put inside HTML, in an element or a double-quoted attribute. The one place this is written. */
export const escapeHtml = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
