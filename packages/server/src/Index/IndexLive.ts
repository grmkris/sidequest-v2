import * as Cloudflare from '@alchemy.run/cloudflare'
import { Effect, Layer } from 'effect'
import { ChainFacts } from './ChainFacts.ts'
import { ChainLogPoller } from './ChainLogPoller.ts'
import { D1EventStore } from './EventStore.ts'
import { Ingest } from './Ingest.ts'
import { Jobs } from './Jobs.ts'
import { Listings } from './Listings.ts'
import { PayPerCall } from './PayPerCall.ts'
import { Moderation } from './Moderation.ts'
import { Settler } from '../Escrow/Settler.ts'
import { Outbox } from './Outbox.ts'
import { Poller } from './Poller.ts'
import { RateLimiter } from '@sidequest/serving/RateLimiter'

/**
 * The index's services over D1: its event store, ingestion, the publish-through rate limiter, the outbox, the relay
 * poller, the chain facts, the listing and job reads, the x402 rail's receipts and the hide list. Needs the database's `SqlClient` and the `IndexSettings`.
 * The chain log poller is separate (`ChainLogPoller`): it needs the settlement chain, which not every stage has.
 */
export const IndexLive = Layer.mergeAll(Poller.layer, Outbox.layer, Jobs.layer).pipe(
  Layer.provideMerge(Layer.mergeAll(Ingest.layer, RateLimiter.layer, Listings.layer, PayPerCall.layer, Moderation.layer)),
  Layer.provideMerge(Layer.merge(D1EventStore, ChainFacts.layer)),
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
 * The index's schedule, as Cron Triggers on the API Worker (`Cloudflare.Workers.cron`): the outbox, the pruning of
 * rate-limit windows, the chain log poller and then the escrow's settler (`Escrow/Settler.ts`, which reads
 * what the poller just recorded) every minute, in that order, and the relay poller every ten. The chain log poller and
 * the settler are disabled, and run nothing, on a stage without settlement. A Cron Trigger rather than a Durable Object alarm: the work
 * is one job for the whole index (no per-entity state to keep), the pinned Alchemy wires a trigger and its handler in
 * one call, and a fire that fails is simply the next fire's work, since every step is idempotent and durable in D1.
 * Each handler's failures are logged; the event source never lets one take the Worker down. With no relays
 * configured, both runs find nothing to do and connect nowhere.
 */
export const indexSchedule = Effect.gen(function* () {
  const poller = yield* Poller
  const outbox = yield* Outbox
  const limiter = yield* RateLimiter
  const chainLogs = yield* ChainLogPoller
  const settler = yield* Settler
  yield* Cloudflare.Workers.cron('* * * * *', () =>
    Effect.all(
      [
        logged('deliver', outbox.deliver),
        logged('prune', limiter.prune(rateLimitRetentionSeconds)),
        logged('pollChain', chainLogs.run),
        logged('settle', settler.run),
      ],
      { discard: true },
    ),
  )
  yield* Cloudflare.Workers.cron('*/10 * * * *', () => logged('poll', poller.run))
})
