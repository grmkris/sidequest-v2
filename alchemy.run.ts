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
    // The default inbox relays (NIP-17) the identity page offers people who have none; unset, none are offered.
    const defaultInboxRelays = yield* Config.String('SIDEQUEST_DEFAULT_INBOX_RELAYS').pipe(Config.withDefault(''))
    // The agent gateway's public URL, which the edge proxies the website's agents page to (`/gateway`) and the page
    // shows MCP clients; unset, the website says agents are not available on this stage. It is the gateway's URL from a
    // deploy before (the gateway needs the core's URL, so the two cannot name each other in one plan).
    const gatewayUrl = yield* Config.String('SIDEQUEST_GATEWAY_URL').pipe(Config.withDefault(''))
    // The agent gateway's secret comes from the deploying shell; unset, the stage runs without a gateway.
    const gatewaySecret = yield* gatewaySecretFromShell
    const core = yield* sidequestWorkers(
      release,
      (api) =>
        Cloudflare.Website.Foldkit('SidequestWebsite', {
          rootDir: 'apps/web',
          env: {
            VITE_SIDEQUEST_RELEASE: release,
            API: api,
            SIDEQUEST_DEFAULT_INBOX_RELAYS: defaultInboxRelays,
            SIDEQUEST_GATEWAY_URL: gatewayUrl,
          },
          compatibility,
          observability,
          workersDev: { enabled: false, previewsEnabled: false },
        }),
      arcRpcUrl,
      settlement,
      index,
      'public',
      gatewayUrl,
    )
    // The gateway reaches the core only at its public URL, as any third party would.
    if (Option.isNone(gatewaySecret)) return core
    const gateway = yield* gatewayWorker({ coreUrl: core.url, release, secret: gatewaySecret.value })
    return { ...core, ...gateway }
  }),
)
