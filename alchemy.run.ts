import * as Cloudflare from '@alchemy.run/cloudflare'
import * as Alchemy from 'alchemy'
import { Config, Effect } from 'effect'
import { settlementVariablesFromShell, stageRpcUrl } from '@sidequest/server/Settlement/SettlementStage'
import { compatibility, observability, sidequestWorkers } from '@sidequest/server/Stack'

export default Alchemy.Stack(
  'SidequestV2',
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const release = yield* Config.String('SIDEQUEST_RELEASE').pipe(Config.withDefault('local-build'))
    // Settlement's addresses and keys come from the deploying shell; unset, the stage runs without settlement.
    const settlement = yield* settlementVariablesFromShell
    const arcRpcUrl = yield* stageRpcUrl
    return yield* sidequestWorkers(
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
    )
  }),
)
