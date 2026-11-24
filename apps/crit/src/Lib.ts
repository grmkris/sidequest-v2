/**
 * `/lib/*`: the files every page may load, bundled into the Worker as text and served to everyone, so a page's
 * `/lib/base.css` works signed in, in public and by its share link. pele (obsidianmd/pele, MIT) draws Mermaid diagrams.
 */
import peleJs from 'pele/global?raw'
import baseCss from './lib/base.css?raw'
import commentsJs from './lib/comments.js?raw'
import diagramsJs from './lib/diagrams.js?raw'
import { guardHeaders } from './Http.ts'

const javascript = 'text/javascript; charset=utf-8'
const files: Readonly<Record<string, { readonly body: string; readonly type: string }>> = {
  '/lib/base.css': { body: baseCss, type: 'text/css; charset=utf-8' },
  '/lib/pele.js': { body: peleJs, type: javascript },
  '/lib/diagrams.js': { body: diagramsJs, type: javascript },
  // Built from client/comments.ts by `bun run build:client`.
  '/lib/comments.js': { body: commentsJs, type: javascript },
}

/** The library file at this path, or undefined when there is none. */
export const libFile = (request: Request, pathname: string): Response | undefined => {
  const file = files[pathname]
  if (file === undefined) return undefined
  return new Response(request.method === 'HEAD' ? null : file.body, {
    headers: { ...guardHeaders, 'content-type': file.type, 'cache-control': 'public, max-age=300' },
  })
}
