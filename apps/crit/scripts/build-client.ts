/**
 * Builds the page script: client/comments.ts → src/lib/comments.js, one self-contained file the Workers serve at
 * /lib/comments.js (src/Lib.ts bundles it as text). The built file is committed; `--check` fails when it is stale.
 *
 *   bun run build:client           build
 *   bun run build:client --check   fail if the committed file differs from a fresh build
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const app = join(import.meta.dir, '..')
const target = join(app, 'src', 'lib', 'comments.js')

const built = await Bun.build({
  entrypoints: [join(app, 'client', 'comments.ts')],
  target: 'browser',
  format: 'iife',
  minify: true,
})
if (!built.success) throw new AggregateError(built.logs, 'client/comments.ts failed to build')
const output = built.outputs[0]
if (output === undefined) throw new Error('client/comments.ts built nothing')
const banner = '/* crit: built from client/comments.ts by `bun run build:client`. Do not edit. */\n'
const fresh = banner + (await output.text())

if (process.argv.includes('--check')) {
  let committed = ''
  try {
    committed = readFileSync(target, 'utf8')
  } catch {
    // A missing file is as stale as a different one.
  }
  if (committed !== fresh) throw new Error('src/lib/comments.js is stale: run `bun run build:client` and commit it')
  console.log('src/lib/comments.js is up to date')
} else {
  writeFileSync(target, fresh)
  console.log(`src/lib/comments.js: ${fresh.length} bytes`)
}
