import * as Cloudflare from '@alchemy.run/cloudflare'
import { Effect, Layer } from 'effect'
import { D1EventStore } from './EventStore.ts'
import { Ingest } from './Ingest.ts'
import { Outbox } from './Outbox.ts'
import { Poller } from './Poller.ts'
import { RateLimiter } from './RateLimiter.ts'

/**
 * The index's services over D1: its event store, ingestion, the publish-through rate limiter, the outbox and the
 * poller. Needs the database's `SqlClient` and the `IndexSettings`.
 */
export const IndexLive = Layer.mergeAll(Poller.layer, Outbox.layer).pipe(
  Layer.provideMerge(Layer.merge(Ingest.layer, RateLimiter.layer)),
  Layer.provideMerge(D1EventStore),
)

/** Rate-limit windows are a minute long; anything older than an hour is gone. */
const rateLimitRetentionSeconds = 3600

/** A scheduled run whose failure is logged, never raised. */
const logged = <A, E>(name: string, effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.tapCause((cause) => Effect.logError(`Sidequest.Index.${name} failed`, cause)),
    Effect.asVoid,
  )

/**
 * The index's schedule, as Cron Triggers on the API Worker (`Cloudflare.Workers.cron`): the outbox and the pruning of
 * rate-limit windows every minute, the poller every ten. A Cron Trigger rather than a Durable Object alarm: the work
 * is one job for the whole index (no per-entity state to keep), the pinned Alchemy wires a trigger and its handler in
 * one call, and a fire that fails is simply the next fire's work, since every step is idempotent and durable in D1.
 * Each handler's failures are logged; the event source never lets one take the Worker down. With no relays
 * configured, both runs find nothing to do and connect nowhere.
 */
export const indexSchedule = Effect.gen(function* () {
  const poller = yield* Poller
  const outbox = yield* Outbox
  const limiter = yield* RateLimiter
  yield* Cloudflare.Workers.cron('* * * * *', () =>
    Effect.all([logged('deliver', outbox.deliver), logged('prune', limiter.prune(rateLimitRetentionSeconds))], {
      discard: true,
    }),
  )
  yield* Cloudflare.Workers.cron('*/10 * * * *', () => logged('poll', poller.run))
})
