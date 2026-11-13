import { Effect, Option, Predicate } from 'effect'

// The website Worker's own stage settings, from workerd's `env`. Vite's dev server runs in Node, which has none.

/** A setting of the Worker's `env`, when it is a string. */
const settingOf = (name: string) =>
  Effect.tryPromise((): Promise<unknown> => import('cloudflare:workers')).pipe(
    Effect.map((runtime) =>
      Predicate.hasProperty(runtime, 'env') &&
      Predicate.hasProperty(runtime.env, name) &&
      Predicate.isString(runtime.env[name])
        ? Option.some(runtime.env[name])
        : Option.none(),
    ),
    Effect.orElseSucceed(() => Option.none<string>()),
  )

/** An origin as these settings name one: `https` (or `http` for a local test stage), a host, no path. */
const isOrigin = (url: string) => /^https?:\/\/[^\s/?#]+$/u.test(url)

/**
 * The stage's agent gateway: `SIDEQUEST_GATEWAY_URL`, an `https` origin (`http` for a local test stage). Unset or
 * malformed, none: the agents page then says agents are not available on this stage. The edge proxies the page's
 * `/gateway` requests to the same setting.
 */
export const gatewayUrl = Effect.map(settingOf('SIDEQUEST_GATEWAY_URL'), (setting) =>
  Option.filter(
    Option.map(setting, (text) => text.trim()),
    isOrigin,
  ),
)

/**
 * The site's one public URL: `SIDEQUEST_SITE_URL`, `https://` and the stage's domain, when it has one. The agents page
 * works only there (the gateway accepts NIP-98 through the edge's proxy for that URL alone), so on any other hostname
 * of the site (its workers.dev one) it sends people there. Unset or malformed, none: every hostname is the site.
 */
export const siteUrl = Effect.map(settingOf('SIDEQUEST_SITE_URL'), (setting) =>
  Option.filter(
    Option.map(setting, (text) => text.trim()),
    isOrigin,
  ),
)

/**
 * The relying party ID passkey-derived keys are made for on the page at `hostname`: `SIDEQUEST_PASSKEY_RP_ID` when the
 * hostname is it or one of its subdomains, as WebAuthn requires; none otherwise (unset, or the site's workers.dev
 * hostname), and the identity page then offers no passkey.
 */
export const passkeyRpIdFor = (setting: Option.Option<string>, hostname: string): Option.Option<string> =>
  Option.filter(
    Option.map(setting, (text) => text.trim().toLowerCase()),
    (rpId) => rpId !== '' && (hostname === rpId || hostname.endsWith(`.${rpId}`)),
  )

/** The stage's relying party ID for passkeys, as set; see {@link passkeyRpIdFor} for the page's. */
export const passkeyRpIdSetting = settingOf('SIDEQUEST_PASSKEY_RP_ID')

/** At most this many default inbox relays are offered. */
const maxDefaultInboxRelays = 4

/**
 * The stage's default inbox relays: `SIDEQUEST_DEFAULT_INBOX_RELAYS`, comma-separated `wss://` URLs (a local test
 * stage may name its `ws://127.0.0.1` relay). Unset or empty, none: the identity page then offers nothing, and the room
 * panel says no inbox relay is configured. Relays that require authentication to read gift wraps are the ones to name
 * (ADR-0004).
 */
export const defaultInboxRelays = settingOf('SIDEQUEST_DEFAULT_INBOX_RELAYS').pipe(
  Effect.map((setting) =>
    Option.match(setting, {
      onNone: () => [],
      onSome: (text) =>
        text
          .split(',')
          .map((url) => url.trim())
          .filter((url) => /^wss?:\/\/[^\s/?#]+[^\s]*$/u.test(url))
          .slice(0, maxDefaultInboxRelays),
    }),
  ),
)
