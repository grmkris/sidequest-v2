import { ProtocolVersion, SidequestApi, type Status } from '@sidequest/protocol'
import { Effect } from 'effect'
import { HttpApiBuilder } from 'effect/http-api'

export const releaseFromEnvironment = (environment: Readonly<Record<string, unknown>>): string => {
  const release = environment.SIDEQUEST_RELEASE
  return typeof release === 'string' && release.length > 0 ? release : 'local-build'
}

export const statusOf = (release: string): Status => ({
  service: 'sidequest-v2',
  status: 'ok',
  protocolVersion: ProtocolVersion.literal,
  release,
})

/** The `system` group of the HTTP API: the service's status and release. */
export const systemHandlers = (release: string) =>
  HttpApiBuilder.group(SidequestApi, 'system', (handlers) =>
    handlers.handle('status', () => Effect.succeed(statusOf(release))),
  )
