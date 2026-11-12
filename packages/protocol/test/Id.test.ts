import { it } from '@effect/vitest'
import { Effect, Option, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { AccountId, AgentId, generateId, JobId, ListingId, ProposalId, RoomId } from '../src/Id.ts'

const kinds = [
  ['AccountId', AccountId, 'account_'],
  ['AgentId', AgentId, 'agent_'],
  ['ListingId', ListingId, 'listing_'],
  ['JobId', JobId, 'job_'],
  ['RoomId', RoomId, 'room_'],
  ['ProposalId', ProposalId, 'proposal_'],
] as const

describe('ids', () => {
  it.effect('generates distinct ids of every kind that their schema accepts', () =>
    Effect.gen(function* () {
      for (const [kind, schema, prefix] of kinds) {
        const ids = yield* Effect.replicateEffect(generateId(kind), 50)
        expect(new Set(ids).size).toBe(50)
        for (const id of ids) {
          expect(id.startsWith(prefix)).toBe(true)
          expect(id).toHaveLength(prefix.length + 26)
          expect(Schema.is(schema)(id)).toBe(true)
        }
      }
    }),
  )

  test.each([
    ['the canonical form', 'job_01JCXZ4Q6N8M2V7T3R5W9Y0B1D', true],
    ['another kind of id', 'room_01JCXZ4Q6N8M2V7T3R5W9Y0B1D', false],
    ['no prefix', '01JCXZ4Q6N8M2V7T3R5W9Y0B1D', false],
    ['lowercase base32', 'job_01jcxz4q6n8m2v7t3r5w9y0b1d', false],
    ['a letter Crockford excludes', 'job_01JCXZ4Q6N8M2V7T3R5W9Y0B1U', false],
    ['a time past 2^48 ms', 'job_81JCXZ4Q6N8M2V7T3R5W9Y0B1D', false],
    ['25 characters', 'job_01JCXZ4Q6N8M2V7T3R5W9Y0B1', false],
    ['27 characters', 'job_01JCXZ4Q6N8M2V7T3R5W9Y0B1DD', false],
  ])('JobId with %s is accepted: %s', (_name, input, expected) => {
    expect(Option.isSome(Schema.decodeUnknownOption(JobId)(input))).toBe(expected)
  })
})
