import { it } from '@effect/vitest'
import { Option, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { Amount } from '../src/Amount.ts'

const accepts = (input: unknown) => Option.isSome(Schema.decodeUnknownOption(Amount)(input))
const maxUint256 = '115792089237316195423570985008687907853269984665640564039457584007913129639935'

describe('Amount', () => {
  test.each(['0', '1', '250000000', '9007199254740993', maxUint256])('accepts %s', (input) => {
    expect(accepts(input)).toBe(true)
  })

  test.each([
    ['an empty string', ''],
    ['a leading zero', '01'],
    ['a sign', '+1'],
    ['a negative', '-1'],
    ['a fraction', '1.5'],
    ['an exponent', '1e6'],
    ['whitespace', ' 1'],
    ['hex', '0x10'],
    ['a number', 1],
    ['a bigint', 1n],
    ['uint256 max + 1', '115792089237316195423570985008687907853269984665640564039457584007913129639936'],
    ['79 digits', '1'.padEnd(79, '0')],
  ])('rejects %s', (_name, input) => {
    expect(accepts(input)).toBe(false)
  })

  it.prop('accepts every non-negative safe integer written in decimal', [Schema.Int], ([n]) =>
    accepts(Math.abs(n).toString()),
  )
})
