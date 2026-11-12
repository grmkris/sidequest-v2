import * as Cloudflare from '@alchemy.run/cloudflare'
import { Stage } from 'alchemy/Stage'
import { Effect } from 'effect'
import { SidequestDatabase, SidequestMedia } from './Resources.ts'
import { arcTestnetRpcUrl } from './SignIn/ArcRpc.ts'
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

/** Sidequest's Workers around one website: the API Worker with its database (migrated from
 * `packages/server/migrations`), its media bucket and the model's Durable Object classes, which the API Worker declares
 * as it builds; the edge in front of both; and the stage, release and Arc RPC endpoint the API runs with. Production
 * builds the website from source and reads Arc testnet's public RPC; the native acceptance test runs the built
 * artifact, because Foldkit's dev mode runs Vite in Node rather than the deployed Worker, and names an RPC endpoint
 * that must not be called. */
export const sidequestWorkers = <R>(
  release: string,
  website: Effect.Effect<Cloudflare.Worker, never, R>,
  arcRpcUrl: string = arcTestnetRpcUrl,
) =>
  Effect.gen(function* () {
    const stage = yield* Stage
    yield* SidequestDatabase
    yield* SidequestMedia
    const api = yield* SidequestWorker
    const site = yield* website
    const edge = yield* Cloudflare.Worker('SidequestEdge', {
      ...edgeWorker,
      env: { API: api, WEBSITE: site },
      workersDev: true,
      observability,
    })
    yield* api.bind('RuntimeConfiguration', {
      env: { SIDEQUEST_ENV: stage, SIDEQUEST_RELEASE: release, SIDEQUEST_ARC_RPC_URL: arcRpcUrl },
    })
    return { url: edge.url.as<string>() }
  }).pipe(Effect.provide(SidequestWorkerLive))
