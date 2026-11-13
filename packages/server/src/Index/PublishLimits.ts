import type { Limit } from '@sidequest/serving/RateLimiter'

/**
 * Publish-through's limits: a client (by IP address) may send 120 events a minute, valid or not, and one key may
 * publish 30. An honest client publishes a handful per action; a relay (strfry, nostr-rs-relay) allows similar.
 */
export const publishLimits = {
  perClient: { limit: 120, windowSeconds: 60 },
  perKey: { limit: 30, windowSeconds: 60 },
} as const satisfies Record<string, Limit>
