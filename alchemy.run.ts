import * as Cloudflare from '@alchemy.run/cloudflare'
import * as Alchemy from 'alchemy'
import { gatewaySecretFromShell, gatewayWorker } from '@sidequest/gateway/Stack'
import { Config, Effect, Option } from 'effect'
import { settlementVariablesFromShell, stageRpcUrl } from '@sidequest/server/Settlement/SettlementStage'
import { indexVariablesFromShell } from '@sidequest/server/Index/IndexConfig'
import { compatibility, observability, sidequestWorkers } from '@sidequest/server/Stack'

export default Alchemy.Stack(
  'SidequestV2',
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const release = yield* Config.String('SIDEQUEST_RELEASE').pipe(Config.withDefault('local-build'))
    // Settlement's addresses and keys come from the deploying shell; unset, the stage runs without settlement.
    const settlement = yield* settlementVariablesFromShell
    const arcRpcUrl = yield* stageRpcUrl
    // The index's relays come from the deploying shell too; unset, it polls and relays nowhere.
    const index = yield* indexVariablesFromShell
    // The agent gateway's secret comes from the deploying shell; unset, the stage runs without a gateway.
    const gatewaySecret = yield* gatewaySecretFromShell
    const core = yield* sidequestWorkers(
      release,
      (api) =>
        Cloudflare.Website.Foldkit('SidequestWebsite', {
          rootDir: 'apps/web',
          env: { VITE_SIDEQUEST_RELEASE: release, API: api },
          compatibility,
          observability,
          workersDev: { enabled: false, previewsEnabled: false },
        }),
      arcRpcUrl,
      settlement,
      index,
    )
    // The gateway reaches the core only at its public URL, as any third party would.
    if (Option.isNone(gatewaySecret)) return core
    const gateway = yield* gatewayWorker({ coreUrl: core.url, release, secret: gatewaySecret.value })
    return { ...core, ...gateway }
  }),
)
