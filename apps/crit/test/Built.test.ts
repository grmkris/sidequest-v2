/**
 * The two checks that need Bun, run from the unit tests so a host project's own test run covers them: the committed
 * page script is what a fresh build gives, and a real Markdown document renders as expected (Bun's parser does not
 * exist under Node). Each runs in crit's folder, wherever the tests were started from.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const app = fileURLToPath(new URL('..', import.meta.url))

const bun = (...args: ReadonlyArray<string>) => {
  const run = spawnSync('bun', args, { cwd: app, encoding: 'utf8' })
  return { status: run.status, output: `${run.stdout}${run.stderr}`.trim(), missing: run.error !== undefined }
}

describe('with Bun', () => {
  it('finds bun on the PATH', () => {
    expect(bun('--version')).toMatchObject({ missing: false, status: 0 })
  })

  it('the committed page script is a fresh build of client/comments.ts', () => {
    expect(bun('scripts/build-client.ts', '--check')).toMatchObject({
      status: 0,
      output: 'src/lib/comments.js is up to date',
    })
  })

  it('renders a real Markdown document', () => {
    expect(bun('scripts/markdown-check.ts')).toMatchObject({ status: 0, output: 'markdown render is as expected' })
  })
})
