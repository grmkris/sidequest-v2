import { Config, ConfigProvider, Effect, Option, Result, Schema } from 'effect'

// Where a stage is reached, from the deploying shell (`alchemy.run.ts`; docs/adr/0005-domains-and-passkey-scope.md):
//
//   SIDEQUEST_SITE_DOMAIN      the hostname of the site (the edge Worker's custom domain), e.g. v2.sidequest.exchange
//   SIDEQUEST_GATEWAY_DOMAIN   the hostname of the agent gateway (its Worker's custom domain); needs the gateway secret
//   SIDEQUEST_GATEWAY_URL      without a gateway domain: the gateway's URL from a deploy before (its workers.dev URL)
//   SIDEQUEST_PASSKEY_RP_ID    the WebAuthn relying party passkey-derived keys are made for; unset, none are offered
//
// Unset, a stage runs on its workers.dev hostnames alone, as local and test stages do. With a domain set, the URLs
// the pieces name each other by are derived from it before anything deploys, so one deploy configures them all.

/** The shell's variables for a stage's domains. */
export const domainVariableNames = {
  site: 'SIDEQUEST_SITE_DOMAIN',
  gateway: 'SIDEQUEST_GATEWAY_DOMAIN',
  gatewayUrl: 'SIDEQUEST_GATEWAY_URL',
  passkeyRpId: 'SIDEQUEST_PASSKEY_RP_ID',
} as const

/** A hostname a Worker can be a custom domain for: two or more lowercase DNS labels, no scheme, port, path or dot at
 * either end. */
const hostnamePattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/u

/** Whether `host` is `parent` or one of its subdomains: what WebAuthn requires of a relying party ID and the page. */
export const isWithin = (host: string, parent: string): boolean => host === parent || host.endsWith(`.${parent}`)

/** What the shell set for the stage's domains; an unset variable is the empty string. */
export interface DomainSettings {
  readonly site: string
  readonly gateway: string
  readonly gatewayUrl: string
  readonly passkeyRpId: string
  /** Whether the stage deploys an agent gateway (`SIDEQUEST_GATEWAY_SECRET` is set). */
  readonly hasGateway: boolean
}

/** What a stage is reached at, and the URLs its pieces name each other by. */
export interface StageDomains {
  /** The edge Worker's custom domain; none, the site is only on its workers.dev hostname. */
  readonly maybeSiteDomain: Option.Option<string>
  /** The gateway Worker's custom domain; none, the gateway is only on its workers.dev hostname. */
  readonly maybeGatewayDomain: Option.Option<string>
  /** The site's one public URL (`https://<site domain>`): the core URL the gateway accepts NIP-98 for and calls, and
   * the URL the website sends people to for what works only there. None without a site domain: the gateway then gets
   * the edge's workers.dev URL, known once the edge deployed. */
  readonly maybeSiteUrl: Option.Option<string>
  /** The gateway's URL the edge proxies to and the agents page shows: `https://<gateway domain>`, else
   * `SIDEQUEST_GATEWAY_URL`; empty for none. */
  readonly gatewayUrl: string
  /** The WebAuthn relying party ID passkeys are made for; none, passkeys are not offered. */
  readonly maybePasskeyRpId: Option.Option<string>
}

/** A domain setting the stage cannot run with: the variable and what is wrong, never anything else. */
export class StageDomainsRefused extends Schema.TaggedError<StageDomainsRefused>()('StageDomainsRefused', {
  variable: Schema.String,
  reason: Schema.Literals(['notAHostname', 'sameAsSite', 'needsGatewaySecret', 'differsFromDomain', 'notWithinSite']),
}) {}

const refused = (variable: string, reason: StageDomainsRefused['reason']) =>
  Result.fail(new StageDomainsRefused({ variable, reason }))

const hostnameOf = (variable: string, setting: string): Result.Result<Option.Option<string>, StageDomainsRefused> =>
  setting === ''
    ? Result.succeed(Option.none())
    : hostnamePattern.test(setting)
      ? Result.succeed(Option.some(setting))
      : refused(variable, 'notAHostname')

/** The gateway's URL: its domain's, or the URL from a deploy before; a domain needs the gateway, and a URL set beside
 * a domain must name it. */
const gatewayUrlOf = (settings: DomainSettings, maybeGateway: Option.Option<string>) =>
  Option.match(maybeGateway, {
    onNone: () => Result.succeed(settings.gatewayUrl),
    onSome: (gateway) => {
      const url = `https://${gateway}`
      if (!settings.hasGateway) return refused(domainVariableNames.gateway, 'needsGatewaySecret')
      return settings.gatewayUrl === '' || settings.gatewayUrl === url
        ? Result.succeed(url)
        : refused(domainVariableNames.gatewayUrl, 'differsFromDomain')
    },
  })

/** The relying party ID: a hostname (or `localhost`, for the native tests), which must be the site's domain or one of
 * its parents when the site has one, or no page of the site could use it. */
const passkeyRpIdOf = (setting: string, maybeSite: Option.Option<string>) => {
  if (setting === '') return Result.succeed(Option.none<string>())
  if (setting !== 'localhost' && !hostnamePattern.test(setting))
    return refused(domainVariableNames.passkeyRpId, 'notAHostname')
  return Option.exists(maybeSite, (site) => !isWithin(site, setting))
    ? refused(domainVariableNames.passkeyRpId, 'notWithinSite')
    : Result.succeed(Option.some(setting))
}

/** A stage's domains and the URLs derived from them, or the first setting it cannot run with. */
export const stageDomainsOf = (settings: DomainSettings): Result.Result<StageDomains, StageDomainsRefused> =>
  Result.gen(function* () {
    const maybeSiteDomain = yield* hostnameOf(domainVariableNames.site, settings.site.trim())
    const maybeGatewayDomain = yield* hostnameOf(domainVariableNames.gateway, settings.gateway.trim())
    if (Option.isSome(maybeGatewayDomain) && Option.contains(maybeSiteDomain, maybeGatewayDomain.value))
      return yield* refused(domainVariableNames.gateway, 'sameAsSite')
    return {
      maybeSiteDomain,
      maybeGatewayDomain,
      maybeSiteUrl: Option.map(maybeSiteDomain, (site) => `https://${site}`),
      gatewayUrl: yield* gatewayUrlOf({ ...settings, gatewayUrl: settings.gatewayUrl.trim() }, maybeGatewayDomain),
      maybePasskeyRpId: yield* passkeyRpIdOf(settings.passkeyRpId.trim(), maybeSiteDomain),
    }
  })

const settingOf = (name: string) => Config.String(name).pipe(Config.withDefault(''))

/** The stage's domains from the deploying shell (see above); fails the deploy, naming the variable to fix and never a
 * value, when one is malformed or contradicts another. */
export const stageDomainsFromShell = (hasGateway: boolean) =>
  Effect.gen(function* () {
    const settings: DomainSettings = {
      site: yield* settingOf(domainVariableNames.site),
      gateway: yield* settingOf(domainVariableNames.gateway),
      gatewayUrl: yield* settingOf(domainVariableNames.gatewayUrl),
      passkeyRpId: yield* settingOf(domainVariableNames.passkeyRpId),
      hasGateway,
    }
    return yield* Effect.fromResult(stageDomainsOf(settings)).pipe(
      Effect.mapError(
        ({ variable, reason }) =>
          new Config.ConfigError(
            new ConfigProvider.SourceError({ message: `Sidequest.Stage.domains: fix ${variable} (${reason})` }),
          ),
      ),
    )
  })

/** A Worker's `domain` prop for a custom domain: the hostname, or nothing, which leaves the Worker on workers.dev and
 * any attachment made outside the stack alone. Cloudflare creates the DNS record and a certificate for the exact
 * hostname, a two-level subdomain included. */
export const customDomainOf = (maybeDomain: Option.Option<string>): { readonly domain?: string } =>
  Option.match(maybeDomain, { onNone: () => ({}), onSome: (domain) => ({ domain }) })
