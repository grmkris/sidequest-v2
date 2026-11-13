import { it } from '@effect/vitest'
import { Effect, Option, Schema } from 'effect'
import { describe, expect } from 'vitest'
import { Erc8004AgentId, erc8004Claim, Erc8004ClaimContent } from '../src/Erc8004Claim.ts'
import type { EventTemplate } from '../src/Event.ts'
import { publicKeyOf, type SecretKey } from '../src/Keys.ts'
import { buildSidequestEvent, parseSidequestEvent } from '../src/SidequestEvent.ts'
import { finalizeEvent } from '../src/Sign.ts'
import { alice, bob, GeneratedSecret, secret, zeros } from './fixtures.ts'

const createdAt = 1_800_000_000
const registry = 'eip155:5042002:0x8004a818bfb912233c491871b3d84c89a494bd9e'
const sign = (template: EventTemplate, key: SecretKey = alice) => finalizeEvent(template, key, zeros)
const claimOf = (fields: Record<string, unknown>) =>
  Schema.decodeUnknownSync(Erc8004ClaimContent)({ subject: publicKeyOf(bob), registry, agentId: '7', ...fields })
const reasonOf = (input: unknown) =>
  parseSidequestEvent(erc8004Claim, input).pipe(
    Effect.map(() => 'accepted'),
    Effect.catch((error) => Effect.succeed(error.reason)),
  )

describe('an ERC-8004 claim', () => {
  it.effect.prop(
    'survives build, sign and parse, on its registry’s chain, naming its subject',
    [
      GeneratedSecret,
      GeneratedSecret,
      Schema.BigInt.check(Schema.isBetweenBigInt({ minimum: 0n, maximum: 2n ** 256n - 1n })),
    ],
    ([author, subject, agentId]) =>
      Effect.gen(function* () {
        const content = claimOf({ subject: publicKeyOf(secret(subject)), agentId: agentId.toString() })
        const event = sign(yield* buildSidequestEvent(erc8004Claim, content, { createdAt }), secret(author))
        const parsed = yield* parseSidequestEvent(erc8004Claim, event)
        expect(parsed.content).toEqual(content)
        expect(parsed.event.tags).toContainEqual(['p', content.subject])
        expect(parsed.envelope.network).toEqual(Option.some('eip155:5042002'))
      }),
  )

  it.effect('carries an MCP endpoint when the operator names one', () =>
    Effect.gen(function* () {
      const content = claimOf({ mcp: 'https://agents.example/mcp' })
      const parsed = yield* parseSidequestEvent(
        erc8004Claim,
        sign(yield* buildSidequestEvent(erc8004Claim, content, { createdAt })),
      )
      expect(parsed.content.mcp).toBe('https://agents.example/mcp')
    }),
  )

  it.effect('refuses another network, another subject in its tag, or a re-signed tamper', () =>
    Effect.gen(function* () {
      const template = yield* buildSidequestEvent(erc8004Claim, claimOf({}), { createdAt })
      const moved = sign({
        ...template,
        tags: template.tags.map((tag) => (tag[0] === 'sq-net' ? ['sq-net', 'eip155:1'] : tag)),
      })
      expect(yield* reasonOf(moved)).toBe('networkMismatch')
      const other = sign({
        ...template,
        tags: template.tags.map((tag) => (tag[0] === 'p' ? ['p', publicKeyOf(alice)] : tag)),
      })
      expect(yield* reasonOf(other)).toBe('tagMismatch')
      expect(yield* reasonOf({ ...sign(template), content: template.content.replace('"7"', '"8"') })).toBe(
        'invalidEvent',
      )
    }),
  )

  it.effect('refuses an agent id that is no uint256, a registry in mixed case and an MCP endpoint off https', () =>
    Effect.gen(function* () {
      const refused = (fields: Record<string, unknown>) =>
        Effect.gen(function* () {
          const honest = yield* buildSidequestEvent(erc8004Claim, claimOf({}), { createdAt })
          const content = JSON.stringify({ subject: publicKeyOf(bob), registry, agentId: '7', ...fields })
          return yield* reasonOf(sign({ ...honest, content }))
        })
      expect(yield* refused({ agentId: '07' })).toBe('badContent')
      expect(yield* refused({ agentId: 7 })).toBe('badContent')
      expect(yield* refused({ agentId: (2n ** 256n).toString() })).toBe('badContent')
      expect(yield* refused({ registry: registry.toUpperCase() })).toBe('badContent')
      expect(yield* refused({ mcp: 'http://agents.example/mcp' })).toBe('badContent')
      expect(Schema.is(Erc8004AgentId)((2n ** 256n - 1n).toString())).toBe(true)
    }),
  )
})
