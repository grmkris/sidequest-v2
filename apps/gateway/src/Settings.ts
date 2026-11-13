import { Context, Option, Redacted, Result, Schema } from 'effect'
import { GatewaySecret } from './Keys/KeyEnvelope.ts'

/**
 * What the gateway runs with: the core's public URL (the only way it reaches Sidequest), the secret that seals agents'
 * keys, how long a grant read from the core is trusted before it is read again, and the release it reports.
 */
export interface GatewayConfig {
  readonly coreUrl: string
  readonly secret: Redacted.Redacted<GatewaySecret>
  readonly grantCacheSeconds: number
  readonly release: string
  /** Which relays room tools dial: `public` (`wss`, a public host) always outside tests; `local` also allows the test
   * relay on `ws://127.0.0.1`. Absent, `public`. */
  readonly relayPolicy?: 'public' | 'local'
}

export class GatewaySettings extends Context.Service<GatewaySettings, GatewayConfig>()(
  'Sidequest/Gateway/GatewaySettings',
) {}

/**
 * How long a grant the core's index showed is trusted before the next tool call reads it again: 30 seconds. An
 * operator's revocation therefore stops their agent within this window, per Worker isolate.
 */
export const defaultGrantCacheSeconds = 30

/** The Worker's variables: `SIDEQUEST_CORE_URL`, the secret `SIDEQUEST_GATEWAY_SECRET`, and optional ones. */
export const gatewayVariableNames = {
  coreUrl: 'SIDEQUEST_CORE_URL',
  secret: 'SIDEQUEST_GATEWAY_SECRET',
  grantCacheSeconds: 'SIDEQUEST_GRANT_CACHE_SECONDS',
  release: 'SIDEQUEST_RELEASE',
  relayPolicy: 'SIDEQUEST_RELAY_POLICY',
} as const

const HttpUrl = Schema.String.check(Schema.isPattern(/^https?:\/\/[^\s/]+$/u))
const CacheSeconds = Schema.FiniteFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 300 }))

/** The gateway is missing or misreads a variable: its name, never its value. */
export class GatewayMisconfigured extends Schema.TaggedError<GatewayMisconfigured>()('GatewayMisconfigured', {
  name: Schema.String,
}) {}

/** The settings from the Worker's environment, or the first variable that is missing or malformed. */
export const settingsFrom = (
  environment: Readonly<Record<string, unknown>>,
): Result.Result<GatewayConfig, GatewayMisconfigured> => {
  const read = <A>(name: string, schema: Schema.Decoder<A>) =>
    Result.fromOption(Schema.decodeUnknownOption(schema)(environment[name]), () => new GatewayMisconfigured({ name }))
  const cacheName = gatewayVariableNames.grantCacheSeconds
  return Result.all({
    coreUrl: read(gatewayVariableNames.coreUrl, HttpUrl),
    secret: Result.map(read(gatewayVariableNames.secret, GatewaySecret), Redacted.make),
    grantCacheSeconds:
      environment[cacheName] === undefined ? Result.succeed(defaultGrantCacheSeconds) : read(cacheName, CacheSeconds),
    relayPolicy: Result.succeed<'public' | 'local'>(
      environment[gatewayVariableNames.relayPolicy] === 'local' ? 'local' : 'public',
    ),
    release: Result.succeed(
      Option.getOrElse(
        Schema.decodeUnknownOption(Schema.NonEmptyString)(environment[gatewayVariableNames.release]),
        () => 'local-build',
      ),
    ),
  })
}
