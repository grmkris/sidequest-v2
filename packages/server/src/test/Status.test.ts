import { Status } from '@sidequest/protocol'
import { Layer, Schema } from 'effect'
import { HttpRouter, HttpServer } from 'effect/http'
import { describe, expect, test } from 'vitest'
import { apiRoutes, releaseFromEnvironment } from '../Status.ts'

describe('releaseFromEnvironment', () => {
  test('uses the deployment release when present', () => {
    expect(releaseFromEnvironment({ SIDEQUEST_RELEASE: '234a6c5' })).toBe('234a6c5')
  })

  test('falls back for missing or empty releases', () => {
    expect(releaseFromEnvironment({})).toBe('local-build')
    expect(releaseFromEnvironment({ SIDEQUEST_RELEASE: '' })).toBe('local-build')
  })
})

describe('GET /api/status', () => {
  test('answers with the Status schema and the given release', async () => {
    const { handler, dispose } = HttpRouter.toWebHandler(
      apiRoutes('234a6c5').pipe(Layer.provide(HttpServer.layerServices)),
      { disableLogger: true },
    )
    try {
      const response = await handler(new Request('http://sidequest.test/api/status'))
      expect(response.status).toBe(200)
      const status = Schema.decodeUnknownSync(Status)(await response.json())
      expect(status.release).toBe('234a6c5')
    } finally {
      await dispose()
    }
  })
})
