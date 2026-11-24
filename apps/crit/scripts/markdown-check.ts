/**
 * Renders a real Markdown document with Bun's parser and checks what comes out. The unit tests run under Node, where
 * that parser does not exist, so this is the check of the render itself; `bun run test:unit` runs it first.
 *
 *   bun scripts/markdown-check.ts
 */
import { strict as assert } from 'node:assert'
import { markdownPage, renderMarkdown } from './markdown.ts'

const source = `# A plan & its parts

First paragraph, with a [doc](docs/STATUS.md) and an ![shot](shots/a.png).

- [x] done
- [ ] open

| What | When |
| --- | --- |
| Ship | Friday |

\`\`\`mermaid
flowchart LR
  A[Publish] --> B[Review]
\`\`\`

\`\`\`ts
const answer = 42
\`\`\`
`

const rendered = renderMarkdown(source, {
  link: (href) => `https://example.test/blob/${href}`,
  image: (src) => `_files/${src.replaceAll('/', '-')}`,
})
const page = markdownPage(rendered, {
  fallbackTitle: 'plan',
  date: '2026-11-13',
  source: 'From a/b · plan.md at 1234abcd',
})

assert.equal(rendered.title, 'A plan & its parts')
assert.ok(rendered.description.startsWith('First paragraph'), 'the first paragraph is the description')
assert.match(rendered.body, /<h1 id="[^"]+" data-review-id="h-[0-9a-f]{8}">A plan &amp; its parts<\/h1>/u)
assert.match(rendered.body, /<p data-review-id="p-[0-9a-f]{8}">First paragraph/u)
assert.match(rendered.body, /href="https:\/\/example\.test\/blob\/docs\/STATUS\.md"/u)
assert.match(rendered.body, /<img src="_files\/shots-a\.png" alt="shot"/u)
assert.match(rendered.body, /<li data-review-id="li-[0-9a-f]{8}"><input type="checkbox" disabled checked> done/u)
assert.match(rendered.body, /<tr data-review-id="tr-[0-9a-f]{8}"><td>Ship<\/td>/u)
assert.match(rendered.body, /<figure class="diagram" data-review-id="d-[0-9a-f]{8}" data-crit-source="flowchart LR/u)
assert.match(rendered.body, /<svg[^>]+class="pele/u)
assert.match(rendered.body, /<pre data-lang="ts" data-review-id="code-[0-9a-f]{8}"><code>const answer = 42/u)
assert.match(page, /<title>A plan &amp; its parts<\/title>/u)
assert.match(page, /<meta name="date" content="2026-11-13" \/>/u)
assert.match(page, /<footer>From a\/b · plan\.md at 1234abcd<\/footer>/u)
console.log('markdown render is as expected')
