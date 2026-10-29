import { execFileSync } from 'node:child_process'
import { expect, test } from 'vitest'
import * as DomainCloudflare from '@alchemy.run/cloudflare/Domain'
import { Layer } from 'effect'

test('the published Cloudflare Domain adapter resolves under Node and Bun', () => {
  expect(Layer.isLayer(DomainCloudflare.DurableObjects)).toBe(true)
  const source = `
    import { DurableObjects } from '@alchemy.run/cloudflare/Domain';
    import { Layer } from 'effect';
    if (!Layer.isLayer(DurableObjects)) process.exit(1);
  `
  expect(() =>
    execFileSync('bun', ['-e', source], {
      cwd: `${import.meta.dirname}/..`,
      timeout: 15000,
      stdio: 'pipe',
    }),
  ).not.toThrow()
})
