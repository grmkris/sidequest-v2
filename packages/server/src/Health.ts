import { Effect } from 'effect'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'

export const releaseFromEnvironment = (environment: Readonly<Record<string, unknown>>): string => {
  const release = environment.SIDEQUEST_RELEASE
  return typeof release === 'string' && release.length > 0 ? release : 'local-build'
}

export const health = Effect.fn('Sidequest.health')(function* (release: string) {
  return yield* HttpServerResponse.json({
    service: 'sidequest-v2',
    status: 'ok',
    protocolVersion: '0.1-foundation',
    release,
  })
})
