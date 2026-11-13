import { it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { TestClock } from 'effect/testing'
import { describe, expect } from 'vitest'
import { RateLimiter, windowOf } from '@sidequest/serving/RateLimiter'
import { localSql } from './LocalSql.ts'

const limit = { limit: 3, windowSeconds: 60 }

/** What `count` takes from `bucket` answer: ok, or the seconds a refusal says to wait. */
const takes = (bucket: string, count: number) =>
  Effect.flatMap(RateLimiter, (limiter) =>
    Effect.forEach(Array.from({ length: count }), () =>
      limiter.take(bucket, limit).pipe(
        Effect.as('ok' as const),
        Effect.catchTag('RateLimited', ({ retryAfterSeconds }) => Effect.succeed(retryAfterSeconds)),
      ),
    ),
  )

const limiterOnD1 = () => RateLimiter.layer.pipe(Layer.provide(localSql().layer))

describe('the rate limiter', () => {
  it.effect('allows the limit per window and bucket, says when the window ends, and starts afresh after it', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_800_000_010_000)
      expect(yield* takes('ip:a', 4)).toEqual(['ok', 'ok', 'ok', 50])
      expect(yield* takes('ip:b', 1)).toEqual(['ok'])
      yield* TestClock.adjust('49 seconds')
      expect(yield* takes('ip:a', 1)).toEqual([1])
      yield* TestClock.adjust('1 second')
      expect(yield* takes('ip:a', 3)).toEqual(['ok', 'ok', 'ok'])
    }).pipe(Effect.provide(limiterOnD1())),
  )

  it.effect('forgets windows older than it keeps', () => {
    const { sqlite, layer } = localSql()
    return Effect.gen(function* () {
      yield* TestClock.setTime(1_800_000_000_000)
      yield* takes('ip:a', 1)
      yield* TestClock.adjust('2 hours')
      yield* takes('ip:a', 1)
      yield* Effect.flatMap(RateLimiter, (limiter) => limiter.prune(3600))
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM rate_limits').get()?.['n']).toBe(1)
    }).pipe(Effect.provide(RateLimiter.layer.pipe(Layer.provide(layer))))
  })

  it('measures a window from its start', () => {
    expect(windowOf(1_800_000_010, 60)).toEqual({ start: 1_800_000_000, remaining: 50 })
    expect(windowOf(1_800_000_000, 60)).toEqual({ start: 1_800_000_000, remaining: 60 })
  })
})
