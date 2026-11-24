/* global pele */
/* crit: draws every Mermaid diagram on the page with pele (load /lib/pele.js first). A diagram is
   <pre class="mermaid">text</pre> or <div class="diagram" data-mermaid>text</div>. pele's data-id attributes on
   nodes and edges are left as they are: comments anchor to diagram parts through them.
   Loaded with `defer`, it draws as soon as it runs (the page is parsed by then), so a script after it, such as
   /lib/comments.js, finds the diagrams drawn. */
const draw = () => {
  for (const element of document.querySelectorAll('pre.mermaid, .diagram[data-mermaid]')) {
    if (element.dataset.critSource !== undefined) continue
    const text = (element.textContent ?? '').trim()
    // Kept for the comments script: a diagram's comments are anchored to its source, which the drawing replaces.
    element.dataset.critSource = text
    element.textContent = ''
    pele.mount(element, text)
  }
}
if (document.readyState === 'loading') addEventListener('DOMContentLoaded', draw)
else draw()
