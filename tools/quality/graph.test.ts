import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test } from 'vitest'
import { assertBrowserSafe, checkDirection, checkGraph } from './graph.ts'
import { importsOf, sourceFiles } from './source.ts'

const withSources = async <A>(sources: Record<string, string>, run: (root: string) => Promise<A>) => {
  const root = await mkdtemp(join(tmpdir(), 'sidequest-graph-'))
  try {
    for (const [file, contents] of Object.entries({
      'apps/web/package.json': JSON.stringify({ name: '@sidequest/web' }),
      ...sources,
    })) {
      const path = join(root, file)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, contents)
    }
    return await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('import auditing sees re-exports, type imports and dynamic imports without matching strings', () => {
  const source = `export * from '@sidequest/auth/storage'; import type { A } from './a.ts';
    const text = "import('ignored')"; import('@sidequest/db'); require('node:fs'); import fs = require('fs');`
  expect(importsOf('fixture.ts', source)).toEqual([
    '@sidequest/auth/storage',
    './a.ts',
    '@sidequest/db',
    'node:fs',
    'fs',
  ])
  expect(() => importsOf('fixture.ts', 'import(userInput)')).toThrow('Computed module import')
})

test('domain cannot depend on persistence and browser cannot reach adapters through re-exports', () => {
  expect(() => checkDirection('@sidequest/domain', '@sidequest/db')).toThrow('Forbidden dependency')
  expect(() => checkDirection('@sidequest/auth', '@sidequest/server')).toThrow('Forbidden dependency')
  expect(() => checkDirection('@sidequest/server', '@sidequest/auth')).not.toThrow()
  expect(() => checkDirection('@sidequest/auth', '@sidequest/i18n')).not.toThrow()
  expect(() => checkDirection('@sidequest/i18n', '@sidequest/auth')).toThrow('Forbidden dependency')
  // The shared contracts stay browser-safe: they may use auth's contract, never server code.
  expect(() => checkDirection('@sidequest/protocol', '@sidequest/auth')).not.toThrow()
  expect(() => checkDirection('@sidequest/protocol', '@sidequest/server')).toThrow('Forbidden dependency')
  expect(() => checkDirection('@sidequest/web', '@sidequest/protocol')).not.toThrow()
  for (const file of [
    'packages/auth/src/storage.ts',
    'packages/auth/src/EmailEntry.ts',
    'packages/db/src/index.ts',
    'apps/web/src/server/Secret.ts',
  ])
    expect(() => assertBrowserSafe(file, '')).toThrow('Server adapter')
  expect(() => assertBrowserSafe('apps/web/src/entry.ts', 'node:fs')).toThrow('Server adapter')
  expect(() => assertBrowserSafe('packages/auth/src/client.ts', '@yielded/auth/Client')).not.toThrow()
  expect(() => assertBrowserSafe('packages/auth/src/EmailEntryContract.ts', '@yielded/auth')).not.toThrow()
})

test.each(['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'])(
  'audits and rejects a server import behind a %s re-export',
  async (extension) => {
    await withSources(
      {
        'apps/web/src/entry.ts': `import './bridge.${extension}'`,
        [`apps/web/src/bridge.${extension}`]:
          extension === 'cjs' ? "module.exports = require('./server/Secret.ts')" : "export * from './server/Secret.ts'",
        'apps/web/src/server/Secret.ts': 'export const secret = 1',
      },
      async (root) => {
        expect(await sourceFiles(root)).toHaveLength(3)
        await expect(checkGraph(root)).rejects.toThrow('Server adapter in browser graph')
      },
    )
  },
)

test.each(['fs', 'fs/promises', 'node:fs', 'bun:sqlite'])(
  'rejects the server runtime import %s through a JavaScript bridge',
  async (specifier) => {
    await withSources(
      {
        'apps/web/src/entry.ts': "import './bridge.js'",
        'apps/web/src/bridge.js': `import '${specifier}'`,
      },
      async (root) => {
        await expect(checkGraph(root)).rejects.toThrow('Server adapter in browser graph')
      },
    )
  },
)

test('resolves extensionless barrels and TypeScript implementations of JavaScript imports', async () => {
  await withSources(
    {
      'apps/web/src/entry.ts': "import './barrel'",
      'apps/web/src/barrel/index.ts': "export * from '../safe.js'",
      'apps/web/src/safe.ts': 'export const value = 1',
    },
    async (root) => {
      expect(await checkGraph(root)).toEqual({ files: 3, browserModules: 3 })
    },
  )
})

test('fails closed on an unresolved browser source', async () => {
  await withSources({ 'apps/web/src/entry.ts': "import './missing.js'" }, async (root) => {
    await expect(checkGraph(root)).rejects.toThrow('Unresolved source import')
  })
})

test.each([
  { imported: 'mjs', source: 'mts' },
  { imported: 'cjs', source: 'cts' },
])('follows the $source implementation of a $imported import', async ({ imported, source }) => {
  await withSources(
    {
      'apps/web/src/entry.ts': `import './bridge.${imported}'`,
      'apps/web/src/bridge.ts': 'export const safe = 1',
      [`apps/web/src/bridge.${source}`]: "import fs = require('fs')",
    },
    async (root) => {
      await expect(checkGraph(root)).rejects.toThrow('Server adapter in browser graph')
    },
  )
})

test('requires explicit imports when source resolution would be ambiguous', async () => {
  await withSources(
    {
      'apps/web/src/entry.ts': "import './bridge'",
      'apps/web/src/bridge.ts': 'export const value = 1',
      'apps/web/src/bridge.js': "import 'fs'",
    },
    async (root) => {
      await expect(checkGraph(root)).rejects.toThrow('Ambiguous source import')
    },
  )
})
