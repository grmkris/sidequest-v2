import * as Cloudflare from '@alchemy.run/cloudflare'
import { Stage } from 'alchemy/Stage'
import { Effect } from 'effect'
import { SidequestDatabase, SidequestMedia } from './Resources.ts'
import { arcTestnetRpcUrl } from './Settlement/ArcRpc.ts'
import type { SettlementVariables } from './Settlement/SettlementStage.ts'
import type { IndexVariables } from './Index/IndexConfig.ts'
import type { RelayUrlPolicy } from './Index/RelayUrls.ts'
import SidequestWorkerLive, { SidequestWorker } from './SidequestWorker.ts'

export const compatibility = { date: '2026-10-19' }

export const observability = {
  enabled: true,
  redactQueryString: true,
  logs: { enabled: true, invocationLogs: true },
  traces: { enabled: true, headSamplingRate: 1 },
}

/** The public edge's Worker: its entry, and the built client files it serves before the Worker runs. Its `fetch`
 * reaches only the public internet, never this zone's origin: the relay pipe dials relays a page names. */
export const edgeWorker = {
  main: 'packages/server/src/EdgeWorker.ts',
  assets: { directory: 'apps/web/dist/client' },
  compatibility: { ...compatibility, flags: ['global_fetch_strictly_public'] },
}

/** Sidequest's Workers around one website: the API Worker with its database (migrated from
 * `packages/server/migrations`) and its media bucket; the website, made with a service binding to the API Worker
 * (`API`) that it reads a page's data through as it renders it; the edge in front of both; and the stage, release and
 * Arc RPC endpoint the API runs with. The API Worker hosts no Durable Object class: a stage deployed with phase 1's
 * classes has them deleted by the next deploy (docs/PHASE-2.md, "Deploying over phase 1"). Production
 * builds the website from source and reads Arc testnet's public RPC; the native acceptance test runs the built
 * artifact, because Foldkit's dev mode runs Vite in Node rather than the deployed Worker, and names an RPC endpoint
 * that must not be called. Settlement is bound only when `settlement` names it (see `Settlement/SettlementStage.ts`):
 * the keys as secrets, the rest as plain variables. The index's relays are bound only when `index` names them (see
 * `Index/IndexConfig.ts`); without them it connects to no relay at all. The edge's relay pipe dials public relays only;
 * `relayPolicy: 'local'` lets it reach the test relay on 127.0.0.1, and only the native tests pass it. `gatewayUrl` is the
 * stage's agent gateway (`SIDEQUEST_GATEWAY_URL`), which the edge proxies the website's `/gateway` requests to; the
 * website needs it too, which its caller binds. */
export const sidequestWorkers = <R>(
  release: string,
  website: (api: Cloudflare.Worker) => Effect.Effect<Cloudflare.Worker, never, R>,
  arcRpcUrl: string = arcTestnetRpcUrl,
  settlement: SettlementVariables = {},
  index: IndexVariables = {},
  relayPolicy: RelayUrlPolicy = 'public',
  gatewayUrl = '',
) =>
  Effect.gen(function* () {
    const stage = yield* Stage
    yield* SidequestDatabase
    yield* SidequestMedia
    const api = yield* SidequestWorker
    const site = yield* website(api)
    const edge = yield* Cloudflare.Worker('SidequestEdge', {
      ...edgeWorker,
      env: {
        API: api,
        WEBSITE: site,
        ...(relayPolicy === 'local' ? { SIDEQUEST_RELAY_POLICY: 'local' } : {}),
        ...(gatewayUrl === '' ? {} : { SIDEQUEST_GATEWAY_URL: gatewayUrl }),
      },
      workersDev: true,
      observability,
    })
    yield* api.bind('RuntimeConfiguration', {
      env: {
        SIDEQUEST_ENV: stage,
        SIDEQUEST_RELEASE: release,
        SIDEQUEST_ARC_RPC_URL: arcRpcUrl,
        ...settlement,
        ...index,
      },
    })
    return { url: edge.url.as<string>() }
  }).pipe(Effect.provide(SidequestWorkerLive))
