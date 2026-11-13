import { RateLimited, type Unavailable } from '@sidequest/protocol'
import { Clock, Context, Effect, Layer, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'
import { stored } from './Stored.ts'

/** The clock's time in whole Unix seconds. */
const nowSeconds = Effect.map(Clock.currentTimeMillis, (millis) => Math.floor(millis / 1000))

/** At most `limit` takes per bucket in each window of `windowSeconds`. */
export interface Limit {
  readonly limit: number
  readonly windowSeconds: number
}

/** The window a moment falls in: its start, and the seconds until the next. */
export const windowOf = (now: number, windowSeconds: number) => {
  const start = now - (now % windowSeconds)
  return { start, remaining: start + windowSeconds - now }
}

/**
 * Fixed-window counters on D1 (`rate_limits`). Each take is one atomic upsert that counts and answers the new count,
 * so concurrent requests from the same client never both slip under the limit, and nothing is held in a Worker's
 * memory, which one isolate does not share with another. A fixed window lets a client send up to twice the limit
 * across a window's edge; for refusing floods that is enough, and it is one row per bucket and minute. D1 rather
 * than a Durable Object: the core's index and the agent gateway write to their D1 on every request that counts, the
 * counter rides the same database, and the tests run it on SQLite as they run everything else. Each database that
 * uses it has the table (`bucket`, `window_start`, `count`). `prune` deletes windows that have ended.
 */
export class RateLimiter extends Context.Service<
  RateLimiter,
  {
    /** Counts one take from `bucket`; fails with `RateLimited` once the window's limit is spent. */
    readonly take: (bucket: string, limit: Limit) => Effect.Effect<void, RateLimited | Unavailable>
    readonly prune: (olderThanSeconds: number) => Effect.Effect<void, Unavailable>
  }
>()('Sidequest/Index/RateLimiter') {
  /** On D1; needs the database's `SqlClient`. */
  static readonly layer = Layer.effect(
    RateLimiter,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const count = SqlSchema.findAll({
        Request: Schema.Struct({ bucket: Schema.String, start: Schema.Int }),
        Result: Schema.Struct({ count: Schema.Int }),
        execute: ({ bucket, start }) => sql`
          INSERT INTO rate_limits (bucket, window_start, count) VALUES (${bucket}, ${start}, 1)
          ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_limits.count + 1
          RETURNING count`,
      })
      return RateLimiter.of({
        take: Effect.fn('Sidequest.Index.rateLimit')(function* (bucket, { limit, windowSeconds }) {
          const window = windowOf(yield* nowSeconds, windowSeconds)
          const [taken] = yield* stored(count({ bucket, start: window.start }))
          if (taken !== undefined && taken.count > limit)
            return yield* new RateLimited({ retryAfterSeconds: window.remaining })
        }),
        prune: Effect.fn('Sidequest.Index.pruneRateLimits')(function* (olderThanSeconds) {
          const cutoff = (yield* nowSeconds) - olderThanSeconds
          yield* stored(sql`DELETE FROM rate_limits WHERE window_start < ${cutoff}`)
        }),
      })
    }),
  )
}
