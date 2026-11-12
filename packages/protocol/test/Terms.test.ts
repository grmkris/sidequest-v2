import { Option, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { Terms } from '../src/Terms.ts'
import { encodedTerms } from './fixtures.ts'

const accepts = (overrides: Record<string, unknown>) =>
  Option.isSome(Schema.decodeUnknownOption(Terms)({ ...encodedTerms, ...overrides }))

const hour = 3600
const day = 86400

describe('Terms', () => {
  test.each([
    ['reviewWindowSeconds', hour - 1, false],
    ['reviewWindowSeconds', hour, true],
    ['reviewWindowSeconds', 14 * day, true],
    ['reviewWindowSeconds', 14 * day + 1, false],
    ['disputeWindowSeconds', hour - 1, false],
    ['disputeWindowSeconds', hour, true],
    ['disputeWindowSeconds', 14 * day, true],
    ['disputeWindowSeconds', 14 * day + 1, false],
    ['arbitrationWindowSeconds', 12 * hour - 1, false],
    ['arbitrationWindowSeconds', 12 * hour, true],
    ['arbitrationWindowSeconds', 14 * day, true],
    ['arbitrationWindowSeconds', 14 * day + 1, false],
    ['reviewWindowSeconds', 2 * hour + 0.5, false],
  ])('%s = %d is accepted: %s', (field, seconds, expected) => {
    expect(accepts({ [field]: seconds })).toBe(expected)
  })

  test.each([
    ['rail x402', { rail: 'x402' }],
    ['rail direct', { rail: 'direct' }],
    ['a zero amount', { amount: '0' }],
    ['a float amount', { amount: 2.5 }],
    ['no deliverables', { deliverables: [] }],
    ['an empty title', { title: '' }],
    ['an untrimmed title', { title: ' Logo' }],
    ['a title with an unpaired surrogate', { title: 'Logo \ud800' }],
    ['an unregistered asset', { asset: 'eip155:5042002/erc20:0x0000000000000000000000000000000000000001' }],
    ['a network other than the asset network', { network: 'eip155:8453' }],
    ['a negative deadline', { deliveryDeadline: -1 }],
    ['a deadline in milliseconds as a string', { deliveryDeadline: '1798761600000' }],
  ])('rejects %s', (_name, overrides) => {
    expect(accepts(overrides)).toBe(false)
  })

  test('accepts the fixture', () => {
    expect(accepts({})).toBe(true)
  })
})
