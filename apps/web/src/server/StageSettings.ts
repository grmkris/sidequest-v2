import { Effect, Option, Predicate } from 'effect'

// The website Worker's own stage settings, from workerd's `env`. Vite's dev server runs in Node, which has none.

/** At most this many default inbox relays are offered. */
const maxDefaultInboxRelays = 4

/**
 * The stage's default inbox relays: `SIDEQUEST_DEFAULT_INBOX_RELAYS`, comma-separated `wss://` URLs (a local test
 * stage may name its `ws://127.0.0.1` relay). Unset or empty, none: the identity page then offers nothing, and the room
 * panel says no inbox relay is configured. Relays that require authentication to read gift wraps are the ones to name
 * (ADR-0004).
 */
export const defaultInboxRelays = Effect.tryPromise((): Promise<unknown> => import('cloudflare:workers')).pipe(
  Effect.map((runtime) =>
    Predicate.hasProperty(runtime, 'env') &&
    Predicate.hasProperty(runtime.env, 'SIDEQUEST_DEFAULT_INBOX_RELAYS') &&
    Predicate.isString(runtime.env.SIDEQUEST_DEFAULT_INBOX_RELAYS)
      ? Option.some(runtime.env.SIDEQUEST_DEFAULT_INBOX_RELAYS)
      : Option.none(),
  ),
  Effect.orElseSucceed(() => Option.none<string>()),
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
