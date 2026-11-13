import { it } from '@effect/vitest'
import { UsdcOnArcTestnet } from '@sidequest/protocol'
import { Option, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { editableUnits, formatAmount, formatUnits, parseUnits } from '../src/Amount.ts'
import { Language } from '../src/Language.ts'

const Atomic = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))

describe('amounts for people', () => {
  test('shows atomic units in whole units with the language’s separators, two decimals at least', () => {
    expect(formatUnits('250000000', 6, 'en')).toBe('250.00')
    expect(formatUnits('1234567890', 6, 'en')).toBe('1,234.56789')
    expect(formatUnits('1234567890', 6, 'sl')).toBe('1.234,56789')
    expect(formatUnits('5', 6, 'en')).toBe('0.000005')
    expect(formatUnits('0', 6, 'en')).toBe('0.00')
    expect(formatUnits('1000', 0, 'en')).toBe('1,000')
    expect(formatUnits('123456789012345678901234567890', 18, 'en')).toBe('123,456,789,012.34567890123456789')
  })

  test('names the registered asset', () => {
    expect(formatAmount('300000000', UsdcOnArcTestnet.id, 'en')).toBe('300.00 USDC')
    expect(formatAmount('300500000', UsdcOnArcTestnet.id, 'sl')).toBe('300,50 USDC')
  })

  test('reads what a person typed in their language, and refuses what it would have to guess', () => {
    expect(parseUnits('250.5', 6, 'en')).toEqual(Option.some('250500000'))
    expect(parseUnits(' 250,5 ', 6, 'sl')).toEqual(Option.some('250500000'))
    expect(parseUnits('007.5', 6, 'en')).toEqual(Option.some('7500000'))
    expect(parseUnits('0.000001', 6, 'en')).toEqual(Option.some('1'))
    expect(parseUnits('12', 6, 'en')).toEqual(Option.some('12000000'))
    expect(parseUnits('250,5', 6, 'en')).toEqual(Option.none())
    expect(parseUnits('1.000', 6, 'sl')).toEqual(Option.none())
    expect(parseUnits('1,000.00', 6, 'en')).toEqual(Option.none())
    expect(parseUnits('1.0000001', 6, 'en')).toEqual(Option.none())
    expect(parseUnits('-1', 6, 'en')).toEqual(Option.none())
    expect(parseUnits('1e3', 6, 'en')).toEqual(Option.none())
    expect(parseUnits('', 6, 'en')).toEqual(Option.none())
  })

  it.prop(
    'gives back the same atomic amount from what it puts in a field, in either language',
    [Atomic, Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 18 })), Language],
    ([atomic, decimals, language]) =>
      Option.contains(
        parseUnits(editableUnits(String(atomic), decimals, language), decimals, language),
        String(atomic),
      ),
  )
})
