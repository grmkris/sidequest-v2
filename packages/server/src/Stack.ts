import * as Cloudflare from '@alchemy.run/cloudflare'
import { Stage } from 'alchemy/Stage'
import { Effect } from 'effect'
import { SidequestMedia } from './Resources.ts'
import SidequestWorkerLive, { SidequestWorker } from './SidequestWorker.ts'

export const compatibility = { date: '2026-10-19' }

export const observability = {
  enabled: true,
  redactQueryString: true,
  logs: { enabled: true, invocationLogs: true },
  traces: { enabled: true, headSamplingRate: 1 },
}

/** The public edge's Worker: its entry, and the built client files it serves before the Worker runs. */
export const edgeWorker = {
  main: 'packages/server/src/EdgeWorker.ts',
  assets: { directory: 'apps/web/dist/client' },
  compatibility,
}

/** Sidequest's Workers around one website: the API Worker and its media bucket, the edge in front of both, and the
 * stage and release the API reports. Production builds the website from source; the native acceptance test runs the
 * built artifact, because Foldkit's dev mode runs Vite in Node rather than the deployed Worker. */
export const sidequestWorkers = <R>(release: string, website: Effect.Effect<Cloudflare.Worker, never, R>) =>
  Effect.gen(function* () {
    const stage = yield* Stage
    yield* SidequestMedia
    const api = yield* SidequestWorker
    const site = yield* website
    const edge = yield* Cloudflare.Worker('SidequestEdge', {
      ...edgeWorker,
      env: { API: api, WEBSITE: site },
      workersDev: true,
      observability,
    })
    yield* api.bind('RuntimeConfiguration', { env: { SIDEQUEST_ENV: stage, SIDEQUEST_RELEASE: release } })
    return { url: edge.url.as<string>() }
  }).pipe(Effect.provide(SidequestWorkerLive))
