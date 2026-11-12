import { it } from '@effect/vitest'
import { AgentId, TokenLifetime } from '@sidequest/protocol'
import { Effect, Layer, Option, Schema } from 'effect'
import { describe, expect } from 'vitest'
import { AgentTokens } from '../src/Agents/AgentTokens.ts'
import { localSql } from './LocalSql.ts'

// The token store against D1's SQL: a token names its agent from the second it is issued until the second before it
// expires, and never after it is revoked; only its hash is kept.

const scout = AgentId.make('agent_01JCXZ4Q6N8M2V7T3R5W9Y0B1A')
const other = AgentId.make('agent_01JCXZ4Q6N8M2V7T3R5W9Y0B1B')
const issuedAt = 1_800_000_000
const day = 86_400

const withTokens = <A, E>(use: (tokens: AgentTokens['Service']) => Effect.Effect<A, E>) => {
  const { sqlite, layer } = localSql()
  return Effect.gen(function* () {
    return { result: yield* use(yield* AgentTokens), sqlite }
  }).pipe(Effect.provide(AgentTokens.layer.pipe(Layer.provide(layer))))
}

describe('the agent token store', () => {
  it.effect.prop(
    'finds a token until the second before its expiry, and not from then on',
    [TokenLifetime, Schema.Int.check(Schema.isBetween({ minimum: -3, maximum: 3 }))],
    ([lifetime, fromExpiry]) =>
      withTokens((tokens) =>
        Effect.gen(function* () {
          const issued = yield* tokens.issue(scout, lifetime, issuedAt)
          const elapsed = lifetime + fromExpiry
          const found = yield* tokens.find(issued.token, issuedAt + elapsed)
          expect(Option.map(found, ({ agent }) => agent)).toEqual(
            elapsed < lifetime ? Option.some(scout) : Option.none(),
          )
        }),
      ).pipe(Effect.asVoid),
  )

  it.effect('keeps only the hash, and finds nothing once revoked, for another agent, or by another secret', () =>
    Effect.gen(function* () {
      const { result: kept, sqlite } = yield* withTokens((tokens) =>
        Effect.gen(function* () {
          const issued = yield* tokens.issue(scout, day, issuedAt)
          expect(Option.isSome(yield* tokens.find(issued.token, issuedAt))).toBe(true)
          expect(yield* tokens.revoke(other, issued.id, issuedAt + 1)).toBe(false)
          expect(Option.isSome(yield* tokens.find(issued.token, issuedAt + 1))).toBe(true)
          expect(yield* tokens.find(`sqa_${'0'.repeat(64)}`, issuedAt + 1)).toEqual(Option.none())
          expect(yield* tokens.find(issued.token.toUpperCase(), issuedAt + 1)).toEqual(Option.none())
          expect(yield* tokens.revoke(scout, issued.id, issuedAt + 2)).toBe(true)
          expect(yield* tokens.find(issued.token, issuedAt + 3)).toEqual(Option.none())
          const listed = yield* tokens.page(scout, {})
          expect(listed.items).toEqual([
            { id: issued.id, agent: scout, issuedAt, expiresAt: issuedAt + day, revokedAt: issuedAt + 2 },
          ])
          return issued
        }),
      )
      const stored = JSON.stringify(sqlite.prepare('SELECT * FROM agent_tokens').all())
      expect(stored).not.toContain(kept.token.slice('sqa_'.length))
    }),
  )
})
