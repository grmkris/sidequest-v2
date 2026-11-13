import * as Cloudflare from '@alchemy.run/cloudflare'
import * as Alchemy from 'alchemy'
import { gatewaySecretFromShell, gatewayWorker } from '@sidequest/gateway/Stack'
import { Config, Effect, Option } from 'effect'
import { settlementVariablesFromShell, stageRpcUrl } from '@sidequest/server/Settlement/SettlementStage'
import { indexVariablesFromShell } from '@sidequest/server/Index/IndexConfig'
import { stageDomainsFromShell } from '@sidequest/server/StageDomains'
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
    // The agent gateway's secret comes from the deploying shell; unset, the stage runs without a gateway.
    const gatewaySecret = yield* gatewaySecretFromShell
    // The site's and the gateway's custom domains, the gateway's URL and the passkeys' relying party, from the deploying
    // shell (`StageDomains.ts`). With a gateway domain, the gateway's URL (which the edge proxies the agents page to and
    // the page shows MCP clients) is known before anything deploys; without one it is `SIDEQUEST_GATEWAY_URL`, the
    // gateway's workers.dev URL from a deploy before. Unset, the agents page says agents are not available here.
    const domains = yield* stageDomainsFromShell(Option.isSome(gatewaySecret))
    const siteUrl = Option.getOrElse(domains.maybeSiteUrl, () => '')
    const core = yield* sidequestWorkers(
      release,
      (api) =>
        Cloudflare.Website.Foldkit('SidequestWebsite', {
          rootDir: 'apps/web',
          env: {
            VITE_SIDEQUEST_RELEASE: release,
            API: api,
            SIDEQUEST_DEFAULT_INBOX_RELAYS: defaultInboxRelays,
            SIDEQUEST_GATEWAY_URL: domains.gatewayUrl,
            SIDEQUEST_SITE_URL: siteUrl,
            SIDEQUEST_PASSKEY_RP_ID: Option.getOrElse(domains.maybePasskeyRpId, () => ''),
          },
          compatibility,
          observability,
          workersDev: { enabled: false, previewsEnabled: false },
        }),
      arcRpcUrl,
      settlement,
      index,
      'public',
      domains.gatewayUrl,
      domains.maybeSiteDomain,
    )
    // The gateway reaches the core only at its public URL, as any third party would: the site's domain when it has
    // one, the one URL the gateway accepts NIP-98 for through the core's proxy.
    if (Option.isNone(gatewaySecret)) return core
    const gateway = yield* gatewayWorker({
      coreUrl: Option.getOrElse(domains.maybeSiteUrl, () => core.url),
      release,
      secret: gatewaySecret.value,
      domain: domains.maybeGatewayDomain,
    })
    return { ...core, ...gateway }
  }),
)
