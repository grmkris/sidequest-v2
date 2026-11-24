/**
 * crit's resources for one project: one Worker on one address (src/Worker.ts), one D1 database, one R2 bucket and,
 * when the site has a team side, two Cloudflare Access applications on the Worker's host:
 * - `Team` covers the whole host: the listed emails sign in with a code Cloudflare mails them.
 * - `Open` covers the paths anyone may reach (`/p/*`, `/s/*`, `/api/*`, `/mcp`, `/lib/*`) with a Bypass policy; a
 *   more specific path wins over the host's application.
 * Neither application depends on the Worker, and the Worker's `ACCESS_AUD` comes from `Team`, so Access is in place
 * before the Worker first answers. The Worker checks Access's token itself on every private path (src/Access.ts), so
 * nothing private opens through an address or a path Access does not guard.
 *
 * The Worker's invocation logs are off, because a share link's token is part of the address. The database and the
 * bucket are kept when the stack is torn down, under fixed names, so a deploy that lost its state adopts the live data
 * instead of making empty copies.
 */
import * as Cloudflare from '@alchemy.run/cloudflare'
import { retain } from 'alchemy/RemovalPolicy'
import { Config, Effect } from 'effect'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SiteConfig } from './crit.config.ts'
import { joinTeam, type Team } from './team.ts'

/** Paths relative to the working directory, so state does not record one machine's absolute paths. */
const fromHere = (relative: string): string =>
  path.relative(process.cwd(), fileURLToPath(new URL(relative, import.meta.url)))

const compatibility = { date: '2026-10-19' }

export interface DevOptions {
  /**
   * Tests only (`ALCHEMY_TEST_DEV=1`): there is no Access under local dev, so the test names the audience and the
   * issuer and hands the Worker its own public keys, then signs the tokens it sends. Never in a deploy.
   */
  readonly access?: { readonly jwks: string; readonly audience: string; readonly team: string }
  /** Tests only: how long the clean-up leaves an unused file alone (24 hours when deployed). */
  readonly blobGraceHours?: number
}

/** The host Access guards: the site's own, or the Worker's workers.dev name. */
const hostOf = (site: SiteConfig): string => {
  if (site.domain !== undefined) return site.domain.host
  const subdomain = site.access.kind === 'cloudflare' ? (site.access.workersDevSubdomain ?? '') : ''
  if (subdomain === '') {
    throw new Error("crit.config.ts: Access on workers.dev needs access.workersDevSubdomain (the account's subdomain)")
  }
  return `${site.name}.${subdomain}.workers.dev`
}

/** The two Access applications; answers the audience tag the Worker checks tokens against. */
const accessFor = (site: SiteConfig, access: Extract<SiteConfig['access'], { kind: 'cloudflare' }>, team: Team) =>
  Effect.gen(function* () {
    if (team.emails.length === 0) {
      throw new Error('crit: Access needs someone to admit: list emails in crit.config.ts or CRIT_TEAM')
    }
    const host = hostOf(site)
    // The account's one-time PIN login method: looked up, never created or deleted by this stack.
    const pin = Cloudflare.Access.getIdentityProvider({ type: 'onetimepin' })
    const application = yield* Cloudflare.Access.Application('Team', {
      type: 'self_hosted',
      name: site.title,
      domain: host,
      policies: [{ name: 'Team', decision: 'allow', include: team.emails.map((email) => ({ email })) }],
      sessionDuration: access.sessionDuration,
      allowedIdps: [pin.identityProviderId.as<string>()],
      autoRedirectToIdentity: true,
      sameSiteCookieAttribute: 'lax',
      httpOnlyCookieAttribute: true,
      appLauncherVisible: false,
    })
    const open = ['p/*', 's/*', 'api/*', 'mcp', 'lib/*'].map((rest) => `${host}/${rest}`)
    yield* Cloudflare.Access.Application('Open', {
      type: 'self_hosted',
      name: `${site.title}: open paths`,
      domain: open[0] ?? host,
      destinations: open.map((uri): Cloudflare.Access.ApplicationDestination => ({ type: 'public', uri })),
      policies: [{ name: 'Everyone', decision: 'bypass', include: ['everyone'] }],
      appLauncherVisible: false,
    })
    return application.aud
  })

/** The people crit.config.ts lists. */
const listed = (site: SiteConfig): Team => ({
  emails: site.access.kind === 'cloudflare' ? site.access.emails : [],
  names: site.names,
})

export const resources = (site: SiteConfig, dev: DevOptions = {}) =>
  Effect.gen(function* () {
    const testDev = yield* Config.String('ALCHEMY_TEST_DEV').pipe(Config.withDefault(''))
    if (dev.access !== undefined && testDev !== '1') {
      throw new Error('crit: test keys for Access (dev.access) are for local tests only, never a deploy')
    }
    // People listed outside Git (team.ts), joined with the config's.
    const team = joinTeam(listed(site), yield* Config.String('CRIT_TEAM').pipe(Config.withDefault('')))
    const database = yield* Cloudflare.D1.Database('Database', {
      name: `${site.name}-db`,
      migrations: fromHere('./migrations'),
    }).pipe(retain())
    const blobs = yield* Cloudflare.R2.Bucket('Blobs', { name: `${site.name}-blobs` }).pipe(retain())
    const guard =
      dev.access !== undefined
        ? { ACCESS_AUD: dev.access.audience, ACCESS_TEAM: dev.access.team, ACCESS_JWKS: dev.access.jwks }
        : site.access.kind === 'cloudflare'
          ? {
              ACCESS_AUD: yield* accessFor(site, site.access, team),
              ACCESS_TEAM: site.access.team.replace(/\/+$/u, ''),
            }
          : {}
    const worker = yield* Cloudflare.Worker('Site', {
      name: site.name,
      main: fromHere('./src/Worker.ts'),
      compatibility,
      env: {
        DB: database,
        BLOBS: blobs,
        TITLE: site.title,
        LEAD: site.lead,
        OUTSIDERS: site.outsiders,
        PUBLIC_PAGES: site.publicPages ? 'on' : 'off',
        EXPIRY_DAYS: String(site.expiryDays),
        LINK_DAYS: String(site.linkDays),
        NAMES: JSON.stringify(team.names),
        PUBLISH_TOKEN: yield* Config.Redacted('CRIT_PUBLISH_TOKEN'),
        ...guard,
        ...(dev.blobGraceHours === undefined ? {} : { BLOB_GRACE_HOURS: String(dev.blobGraceHours) }),
      },
      // The clean-up: expired pages, old versions and files nothing uses (src/Sweep.ts).
      crons: ['17 * * * *'],
      observability: { enabled: true, logs: { enabled: true, invocationLogs: false } },
      ...(site.domain === undefined
        ? { workersDev: true }
        : { workersDev: false, domain: { name: site.domain.host, zoneName: site.domain.zone } }),
    })
    return { url: worker.url.as<string>() }
  })
