import { it } from '@effect/vitest'
import { ConfigProvider, Effect, Option, Result } from 'effect'
import { describe, expect, test } from 'vitest'
import { customDomainOf, type DomainSettings, stageDomainsFromShell, stageDomainsOf } from '../src/StageDomains.ts'

// Where a stage is reached, from the deploying shell (ADR-0005): nothing set is today's workers.dev stage; a domain
// set derives every URL the pieces name each other by, before anything deploys; a contradiction refuses the deploy.

const unset: DomainSettings = { site: '', gateway: '', gatewayUrl: '', passkeyRpId: '', hasGateway: true }
const preview: DomainSettings = {
  ...unset,
  site: 'v2.sidequest.exchange',
  gateway: 'agents.v2.sidequest.exchange',
  passkeyRpId: 'sidequest.exchange',
}

const fromShell = (env: Record<string, string>, hasGateway: boolean) =>
  stageDomainsFromShell(hasGateway).pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
  )

const refusal = (settings: DomainSettings) =>
  Result.match(stageDomainsOf(settings), {
    onSuccess: () => 'accepted',
    onFailure: ({ variable, reason }) => `${variable}: ${reason}`,
  })

describe('a stage’s domains', () => {
  test('unset: no custom domain, no site URL, the gateway URL from a deploy before, no passkeys', () => {
    expect(stageDomainsOf(unset)).toEqual(
      Result.succeed({
        maybeSiteDomain: Option.none(),
        maybeGatewayDomain: Option.none(),
        maybeSiteUrl: Option.none(),
        gatewayUrl: '',
        maybePasskeyRpId: Option.none(),
      }),
    )
    const twoPass = stageDomainsOf({ ...unset, gatewayUrl: 'https://gateway.example.workers.dev' })
    expect(Result.map(twoPass, (domains) => domains.gatewayUrl)).toEqual(
      Result.succeed('https://gateway.example.workers.dev'),
    )
    expect(customDomainOf(Option.none())).toEqual({})
  })

  test('set: the URLs are the domains’, so the core URL the gateway verifies NIP-98 for is the site’s', () => {
    expect(stageDomainsOf(preview)).toEqual(
      Result.succeed({
        maybeSiteDomain: Option.some('v2.sidequest.exchange'),
        maybeGatewayDomain: Option.some('agents.v2.sidequest.exchange'),
        maybeSiteUrl: Option.some('https://v2.sidequest.exchange'),
        gatewayUrl: 'https://agents.v2.sidequest.exchange',
        maybePasskeyRpId: Option.some('sidequest.exchange'),
      }),
    )
    expect(customDomainOf(Option.some('v2.sidequest.exchange'))).toEqual({ domain: 'v2.sidequest.exchange' })
    // A gateway URL that names the domain agrees with it.
    expect(refusal({ ...preview, gatewayUrl: 'https://agents.v2.sidequest.exchange' })).toBe('accepted')
    // The relying party may be the site's own hostname, and `localhost` is the native tests'.
    expect(refusal({ ...preview, passkeyRpId: 'v2.sidequest.exchange' })).toBe('accepted')
    expect(refusal({ ...unset, passkeyRpId: 'localhost' })).toBe('accepted')
  })

  test('refuses what the stage cannot run with, naming the variable', () => {
    expect(refusal({ ...preview, site: 'https://v2.sidequest.exchange' })).toBe('SIDEQUEST_SITE_DOMAIN: notAHostname')
    expect(refusal({ ...preview, site: 'v2.sidequest.exchange/' })).toBe('SIDEQUEST_SITE_DOMAIN: notAHostname')
    expect(refusal({ ...preview, gateway: 'Agents.v2.sidequest.exchange' })).toBe(
      'SIDEQUEST_GATEWAY_DOMAIN: notAHostname',
    )
    expect(refusal({ ...preview, gateway: preview.site })).toBe('SIDEQUEST_GATEWAY_DOMAIN: sameAsSite')
    expect(refusal({ ...preview, hasGateway: false })).toBe('SIDEQUEST_GATEWAY_DOMAIN: needsGatewaySecret')
    expect(refusal({ ...preview, gatewayUrl: 'https://old.workers.dev' })).toBe(
      'SIDEQUEST_GATEWAY_URL: differsFromDomain',
    )
    expect(refusal({ ...preview, passkeyRpId: 'sidequest.example' })).toBe('SIDEQUEST_PASSKEY_RP_ID: notWithinSite')
    expect(refusal({ ...preview, passkeyRpId: 'exchange.sidequest.exchange' })).toBe(
      'SIDEQUEST_PASSKEY_RP_ID: notWithinSite',
    )
    expect(refusal({ ...preview, passkeyRpId: 'https://sidequest.exchange' })).toBe(
      'SIDEQUEST_PASSKEY_RP_ID: notAHostname',
    )
  })

  it.effect('from the shell: read when set, a deploy refused with the variable when malformed', () =>
    Effect.gen(function* () {
      const read = yield* fromShell(
        {
          SIDEQUEST_SITE_DOMAIN: 'v2.sidequest.exchange',
          SIDEQUEST_GATEWAY_DOMAIN: 'agents.v2.sidequest.exchange',
          SIDEQUEST_PASSKEY_RP_ID: 'sidequest.exchange',
        },
        true,
      )
      expect(read.gatewayUrl).toBe('https://agents.v2.sidequest.exchange')
      expect((yield* fromShell({}, false)).maybeSiteUrl).toEqual(Option.none())
      const refused = yield* Effect.flip(fromShell({ SIDEQUEST_GATEWAY_DOMAIN: 'agents.v2.sidequest.exchange' }, false))
      expect(String(refused)).toContain('SIDEQUEST_GATEWAY_DOMAIN')
    }),
  )
})
