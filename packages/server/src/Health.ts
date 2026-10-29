import { Effect } from 'effect'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'

export const health = (release: string) =>
  Effect.gen(function* () {
    return yield* HttpServerResponse.json({
      service: 'sidequest-v2',
      status: 'ok',
      protocolVersion: '0.1-foundation',
      release,
    })
  })
