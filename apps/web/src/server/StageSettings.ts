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

/**
 * The stage's agent gateway: `SIDEQUEST_GATEWAY_URL`, an `https` origin (`http` for a local test stage). Unset or
 * malformed, none: the agents page then says agents are not available on this stage. The edge proxies the page's
 * `/gateway` requests to the same setting.
 */
export const gatewayUrl = Effect.map(settingOf('SIDEQUEST_GATEWAY_URL'), (setting) =>
  Option.filter(
    Option.map(setting, (text) => text.trim()),
    (url) => /^https?:\/\/[^\s/?#]+$/u.test(url),
  ),
)

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
