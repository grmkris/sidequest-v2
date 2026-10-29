import { expect, test } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assetUrl, fetchVerified, target, TSRS_LINT } from './tsrs-lint.ts'

test('unsupported lint platforms fail instead of selecting a fallback', () => {
  expect(() => target('win32', 'x64')).toThrow('no release build')
  expect(assetUrl(target('linux', 'x64'))).toContain(TSRS_LINT.tag)
})

test('a corrupted cached backend fails checksum verification before execution', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sidequest-tsrs-'))
  try {
    const file = join(dir, 'backend')
    await writeFile(file, 'corrupt')
    await expect(
      fetchVerified({
        url: 'https://invalid.invalid/unused',
        sha256: TSRS_LINT.sha256['x86_64-unknown-linux-gnu'],
        file,
      }),
    ).rejects.toThrow('sha256')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
