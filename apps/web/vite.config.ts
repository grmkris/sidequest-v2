import { foldkit } from '@foldkit/vite-plugin'
import { defineConfig } from 'vite'
import { zyzz } from 'zyzz/vite'

export default defineConfig({
  // The bundle budget reads which chunks the document loads; public/.assetsignore keeps it unpublished.
  // The server entry reads the Worker's bindings from workerd's own `cloudflare:workers` module, which only the Worker
  // runtime provides, so the server build leaves it to the runtime.
  environments: {
    client: { build: { manifest: true } },
    ssr: { build: { rolldownOptions: { external: ['cloudflare:workers'] } } },
  },
  // CSS browser baseline, made explicit: zyzz requires native light-dark() and emits CSS
  // nesting, so older browsers drop nested state rules (hover, active, user-invalid).
  // Fonts always ship as files: the edge CSP allows `font-src 'self'`, not inlined data: URLs.
  build: {
    cssTarget: ['chrome123', 'edge123', 'firefox120', 'safari17.5'],
    assetsInlineLimit: (file) => (file.endsWith('.woff2') ? false : undefined),
  },
  // zyzz compiles styles before Foldkit's plugin sees the modules.
  plugins: [
    zyzz(),
    foldkit({ ssr: { serverEntry: '/src/entry.server.ts', clientEntry: '/src/entry.ts', build: true } }),
  ],
})
