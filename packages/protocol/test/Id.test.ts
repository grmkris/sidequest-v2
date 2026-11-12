import { it } from '@effect/vitest'
import { Effect, Option, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { AccountId, AgentId, generateId, JobId, ListingId, ProposalId, RoomId, roomIdOf } from '../src/Id.ts'

const kinds = [
  ['AccountId', AccountId, 'account_'],
  ['AgentId', AgentId, 'agent_'],
  ['ListingId', ListingId, 'listing_'],
  ['JobId', JobId, 'job_'],
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

  const job = JobId.make('job_01JCXZ4Q6N8M2V7T3R5W9Y0B1D')
  const bob = AccountId.make('account_01JCXZ4Q6N8M2V7T3R5W9Y0B1B')
  const carol = AccountId.make('account_01JCXZ4Q6N8M2V7T3R5W9Y0B1C')

  test('a room id derives from its job, its kind and its bidder, and nothing else', () => {
    expect(roomIdOf({ job, kind: 'engagement' })).toBe('room_01JCXZ4Q6N8M2V7T3R5W9Y0B1D_engagement')
    expect(roomIdOf({ job, kind: 'negotiation', bidder: bob })).toBe(
      'room_01JCXZ4Q6N8M2V7T3R5W9Y0B1D_negotiation_01JCXZ4Q6N8M2V7T3R5W9Y0B1B',
    )
    expect(roomIdOf({ job, kind: 'negotiation', bidder: carol })).not.toBe(
      roomIdOf({ job, kind: 'negotiation', bidder: bob }),
    )
  })

  test.each([
    ['an engagement room', 'room_01JCXZ4Q6N8M2V7T3R5W9Y0B1D_engagement', true],
    ['a negotiation room', 'room_01JCXZ4Q6N8M2V7T3R5W9Y0B1D_negotiation_01JCXZ4Q6N8M2V7T3R5W9Y0B1B', true],
    ['a minted id', 'room_01JCXZ4Q6N8M2V7T3R5W9Y0B1D', false],
    ['a negotiation without its bidder', 'room_01JCXZ4Q6N8M2V7T3R5W9Y0B1D_negotiation', false],
    ['an engagement naming a bidder', 'room_01JCXZ4Q6N8M2V7T3R5W9Y0B1D_engagement_01JCXZ4Q6N8M2V7T3R5W9Y0B1B', false],
    ['another kind of room', 'room_01JCXZ4Q6N8M2V7T3R5W9Y0B1D_lobby', false],
  ])('RoomId with %s is accepted: %s', (_name, input, expected) => {
    expect(Option.isSome(Schema.decodeUnknownOption(RoomId)(input))).toBe(expected)
  })
})
