import { Option, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { Actor } from '../src/Actor.ts'
import { Grant } from '../src/Grant.ts'
import { accountId } from './fixtures.ts'

const acceptsGrant = (scopes: ReadonlyArray<string>) =>
  Option.isSome(Schema.decodeUnknownOption(Grant)({ scopes, expiresAt: 1798761600 }))

describe('Grant', () => {
  test.each([
    [['discuss'], true],
    [['discuss', 'propose', 'accept', 'deliver'], true],
    [[], false],
    [['pay'], false],
    [['propose', 'propose'], false],
  ])('scopes %j are accepted: %s', (scopes, expected) => {
    expect(acceptsGrant(scopes)).toBe(expected)
  })
})

describe('Actor', () => {
  test.each([
    ['a person', { account: accountId }, true],
    [
      'an agent with scopes',
      { account: accountId, agent: { id: 'agent_01JCXZ4Q6N8M2V7T3R5W9Y0B1D', scopes: ['accept'] } },
      true,
    ],
    [
      'an agent with no scopes',
      { account: accountId, agent: { id: 'agent_01JCXZ4Q6N8M2V7T3R5W9Y0B1D', scopes: [] } },
      false,
    ],
    ['an agent id in the account slot', { account: 'agent_01JCXZ4Q6N8M2V7T3R5W9Y0B1D' }, false],
  ])('%s is accepted: %s', (_name, input, expected) => {
    expect(Option.isSome(Schema.decodeUnknownOption(Actor)(input))).toBe(expected)
  })
})
