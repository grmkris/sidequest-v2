import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

test('foundation runtime files expose the intended boundaries', async () => {
  const edge = await readFile(new URL('../EdgeWorker.ts', import.meta.url), 'utf8')
  const worker = await readFile(new URL('../SidequestWorker.ts', import.meta.url), 'utf8')
  expect(edge).toContain('sidequest-correlation-id')
  expect(worker).toContain('SidequestWorker')
})
