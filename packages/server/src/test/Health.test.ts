import { describe, expect, test } from 'vitest'
import { releaseFromEnvironment } from '../Health.ts'

describe('releaseFromEnvironment', () => {
  test('uses the deployment release when present', () => {
    expect(releaseFromEnvironment({ SIDEQUEST_RELEASE: '234a6c5' })).toBe('234a6c5')
  })

  test('falls back for missing or empty releases', () => {
    expect(releaseFromEnvironment({})).toBe('local-build')
    expect(releaseFromEnvironment({ SIDEQUEST_RELEASE: '' })).toBe('local-build')
  })
})
