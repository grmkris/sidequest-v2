import * as Cloudflare from '@alchemy.run/cloudflare'
import * as Alchemy from 'alchemy'
import { Config, Effect } from 'effect'
import { SidequestMedia } from '@sidequest/server/Resources'
import SidequestWorkerLive, { SidequestWorker } from '@sidequest/server/SidequestWorker'

export default Alchemy.Stack(
  'SidequestV2',
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const release = yield* Config.String('SIDEQUEST_RELEASE')
    yield* SidequestMedia
    const api = yield* SidequestWorker
    const website = yield* Cloudflare.Website.Foldkit('SidequestWebsite', {
      rootDir: 'apps/web',
      env: { VITE_SIDEQUEST_ENV: 'preview', VITE_SIDEQUEST_RELEASE: release },
      compatibility: { date: '2026-10-19' },
      observability: {
        enabled: true,
        redactQueryString: true,
        logs: { enabled: true, invocationLogs: true },
        traces: { enabled: true, headSamplingRate: 1 },
      },
      workersDev: { enabled: false, previewsEnabled: false },
    })
    const edge = yield* Cloudflare.Worker('SidequestEdge', {
      main: 'packages/server/src/EdgeWorker.ts',
      env: { API: api, WEBSITE: website },
      assets: { directory: 'apps/web/dist/client' },
      compatibility: { date: '2026-10-19' },
      workersDev: true,
      observability: {
        enabled: true,
        redactQueryString: true,
        logs: { enabled: true, invocationLogs: true },
        traces: { enabled: true, headSamplingRate: 1 },
      },
    })
    yield* api.bind('RuntimeConfiguration', { env: { SIDEQUEST_ENV: 'preview', SIDEQUEST_RELEASE: release } })
    return { url: edge.url.as<string>() }
  }).pipe(Effect.provide(SidequestWorkerLive)),
)
