import type { Input } from 'alchemy'
import { Config, Effect, Option, Redacted } from 'effect'
import GatewayWorkerLive, { GatewayDomain, GatewayWorker } from './GatewayWorker.ts'
import { GatewayDatabase } from './Resources.ts'
import { gatewayVariableNames } from './Settings.ts'

/** What the gateway's Worker is deployed with: the core's public URL, the release, its secret and the cache window. */
export interface GatewayDeployment {
  readonly coreUrl: Input<string>
  readonly release: string
  readonly secret: Redacted.Redacted
  readonly grantCacheSeconds?: number
  /** `local` only in the native tests, so room tools may reach the test relay on 127.0.0.1. */
  readonly relayPolicy?: 'local'
  /** The gateway's custom domain; none or absent, only its workers.dev hostname. */
  readonly domain?: Option.Option<string>
}

/**
 * The agent gateway beside the core: its own Worker, its own D1 (migrated from `apps/gateway/migrations`) and its own
 * `workers.dev` URL, with `domain` as its custom domain when given, configured with the core's public URL and nothing
 * else of the core's. The core URL is the one URL the gateway accepts NIP-98 for through the core's proxy. The secret
 * binds as a Worker secret. Answers the gateway's URL: its domain's when it has one.
 */
export const gatewayWorker = ({
  coreUrl,
  release,
  secret,
  grantCacheSeconds,
  relayPolicy,
  domain = Option.none(),
}: GatewayDeployment) =>
  Effect.gen(function* () {
    yield* GatewayDatabase
    const gateway = yield* GatewayWorker
    yield* gateway.bind('RuntimeConfiguration', {
      env: {
        [gatewayVariableNames.coreUrl]: coreUrl,
        [gatewayVariableNames.release]: release,
        [gatewayVariableNames.secret]: secret,
        ...(grantCacheSeconds === undefined
          ? {}
          : { [gatewayVariableNames.grantCacheSeconds]: String(grantCacheSeconds) }),
        ...(relayPolicy === undefined ? {} : { [gatewayVariableNames.relayPolicy]: relayPolicy }),
      },
    })
    return { gatewayUrl: gateway.url.as<string>() }
  }).pipe(Effect.provide(GatewayWorkerLive), Effect.provideService(GatewayDomain, domain))

/**
 * The gateway's secret from the deploying shell (`SIDEQUEST_GATEWAY_SECRET`, 64 hex characters, e.g. from
 * `openssl rand -hex 32`); unset, a stage runs without a gateway. Its value is never logged.
 */
export const gatewaySecretFromShell = Config.option(Config.Redacted(gatewayVariableNames.secret)).pipe(
  Config.map(Option.filter((secret) => Redacted.value(secret).length > 0)),
)
