import type { Input } from 'alchemy'
import { Config, Effect, Option, Redacted } from 'effect'
import GatewayWorkerLive, { GatewayWorker } from './GatewayWorker.ts'
import { GatewayDatabase } from './Resources.ts'
import { gatewayVariableNames } from './Settings.ts'

/** What the gateway's Worker is deployed with: the core's public URL, the release, its secret and the cache window. */
export interface GatewayDeployment {
  readonly coreUrl: Input<string>
  readonly release: string
  readonly secret: Redacted.Redacted
  readonly grantCacheSeconds?: number
}

/**
 * The agent gateway beside the core: its own Worker, its own D1 (migrated from `apps/gateway/migrations`) and its own
 * `workers.dev` URL, configured with the core's public URL and nothing else of the core's. The secret binds as a
 * Worker secret. Answers the gateway's URL.
 */
export const gatewayWorker = ({ coreUrl, release, secret, grantCacheSeconds }: GatewayDeployment) =>
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
      },
    })
    return { gatewayUrl: gateway.url.as<string>() }
  }).pipe(Effect.provide(GatewayWorkerLive))

/**
 * The gateway's secret from the deploying shell (`SIDEQUEST_GATEWAY_SECRET`, 64 hex characters, e.g. from
 * `openssl rand -hex 32`); unset, a stage runs without a gateway. Its value is never logged.
 */
export const gatewaySecretFromShell = Config.option(Config.Redacted(gatewayVariableNames.secret)).pipe(
  Config.map(Option.filter((secret) => Redacted.value(secret).length > 0)),
)
