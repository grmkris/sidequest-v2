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
  const source = `export * from '@sidequest/server/Resources'; import type { A } from './a.ts';
    const text = "import('ignored')"; import('@sidequest/fold'); require('node:fs'); import fs = require('fs');`
  expect(importsOf('fixture.ts', source)).toEqual([
    '@sidequest/server/Resources',
    './a.ts',
    '@sidequest/fold',
    'node:fs',
    'fs',
  ])
  expect(() => importsOf('fixture.ts', 'import(userInput)')).toThrow('Computed module import')
})

test('packages depend only downwards and browser code cannot reach adapters through re-exports', () => {
  expect(() => checkDirection('@sidequest/server', '@sidequest/i18n')).not.toThrow()
  expect(() => checkDirection('@sidequest/i18n', '@sidequest/server')).toThrow('Forbidden dependency')
  // The shared contracts stay browser-safe: they never reach server code.
  expect(() => checkDirection('@sidequest/protocol', '@sidequest/server')).toThrow('Forbidden dependency')
  expect(() => checkDirection('@sidequest/web', '@sidequest/protocol')).not.toThrow()
  expect(() => checkDirection('@sidequest/web', '@sidequest/server')).toThrow('Forbidden dependency')
  // The model package is gone (phase 2 has no aggregates): nothing may depend on it again.
  for (const from of ['@sidequest/server', '@sidequest/web', '@sidequest/protocol'])
    expect(() => checkDirection(from, '@sidequest/domain')).toThrow('Forbidden dependency')
  for (const file of ['packages/server/src/Resources.ts', 'apps/web/src/server/Secret.ts'])
    expect(() => assertBrowserSafe(file, '')).toThrow('Server adapter')
  for (const specifier of ['node:fs', 'cloudflare:workers', '@alchemy.run/cloudflare', '@effect/sql-d1'])
    expect(() => assertBrowserSafe('apps/web/src/entry.ts', specifier)).toThrow('Server adapter')
  // Signature verification is the server's: the wallet library never reaches the browser.
  for (const specifier of ['viem', 'viem/siwe', 'viem/accounts'])
    expect(() => assertBrowserSafe('apps/web/src/entry.ts', specifier)).toThrow('Server adapter')
  expect(() => assertBrowserSafe('apps/web/src/entry.ts', 'viem-like')).not.toThrow()
  // Settlement (keys, the relayer, the chain's logs) is the server's alone.
  expect(() => checkDirection('@sidequest/server', '@sidequest/settlement')).not.toThrow()
  expect(() => checkDirection('@sidequest/settlement', '@sidequest/protocol')).not.toThrow()
  for (const from of ['@sidequest/web', '@sidequest/protocol', '@sidequest/fold'])
    expect(() => checkDirection(from, '@sidequest/settlement')).toThrow('Forbidden dependency')
  expect(() => checkDirection('@sidequest/settlement', '@sidequest/server')).toThrow('Forbidden dependency')
  expect(() => assertBrowserSafe('apps/web/src/entry.ts', '@sidequest/settlement/Relayer')).toThrow('Server adapter')
  expect(() => assertBrowserSafe('packages/settlement/src/Relayer.ts', '')).toThrow('Server adapter')
  // Nostr runs in the browser and in Workers: the website and the server may use it, and it reaches only the protocol.
  for (const from of ['@sidequest/web', '@sidequest/server'])
    expect(() => checkDirection(from, '@sidequest/nostr')).not.toThrow()
  expect(() => checkDirection('@sidequest/nostr', '@sidequest/protocol')).not.toThrow()
  for (const to of ['@sidequest/server', '@sidequest/settlement', '@sidequest/fold', '@sidequest/web'])
    expect(() => checkDirection('@sidequest/nostr', to)).toThrow('Forbidden dependency')
  expect(() => checkDirection('@sidequest/protocol', '@sidequest/nostr')).toThrow('Forbidden dependency')
  expect(() => assertBrowserSafe('packages/nostr/src/Sign.ts', '@noble/curves/secp256k1.js')).not.toThrow()
  // The job fold runs in the index and the browser, and reaches only events and the protocol.
  for (const from of ['@sidequest/web', '@sidequest/server'])
    expect(() => checkDirection(from, '@sidequest/fold')).not.toThrow()
  for (const to of ['@sidequest/nostr', '@sidequest/protocol'])
    expect(() => checkDirection('@sidequest/fold', to)).not.toThrow()
  for (const to of ['@sidequest/settlement', '@sidequest/server', '@sidequest/web'])
    expect(() => checkDirection('@sidequest/fold', to)).toThrow('Forbidden dependency')
  for (const from of ['@sidequest/nostr', '@sidequest/protocol', '@sidequest/settlement'])
    expect(() => checkDirection(from, '@sidequest/fold')).toThrow('Forbidden dependency')
  expect(() => assertBrowserSafe('apps/web/src/App.ts', 'foldkit')).not.toThrow()
  expect(() => assertBrowserSafe('packages/protocol/src/index.ts', 'effect')).not.toThrow()
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

test('the agent gateway reaches the core only through its public contracts, and nothing reaches the gateway', () => {
  for (const allowed of ['@sidequest/nostr', '@sidequest/protocol', '@sidequest/fold', '@sidequest/serving'])
    expect(() => checkDirection('@sidequest/gateway', allowed)).not.toThrow()
  for (const core of ['@sidequest/server', '@sidequest/settlement'])
    expect(() => checkDirection('@sidequest/gateway', core)).toThrow('Forbidden dependency')
  for (const from of ['@sidequest/server', '@sidequest/web', '@sidequest/serving'])
    expect(() => checkDirection(from, '@sidequest/gateway')).toThrow('Forbidden dependency')
  // The shared serving pieces hold no key and reach no server code.
  expect(() => checkDirection('@sidequest/serving', '@sidequest/server')).toThrow('Forbidden dependency')
  expect(() => checkDirection('@sidequest/server', '@sidequest/serving')).not.toThrow()
})

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
