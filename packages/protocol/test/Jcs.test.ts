import { it } from '@effect/vitest'
import { Result, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { canonicalize } from '../src/Jcs.ts'

const canonical = (value: Schema.Json) => Result.getOrThrow(canonicalize(value))

const fromBits = (hex: string) => {
  const view = new DataView(new ArrayBuffer(8))
  view.setBigUint64(0, BigInt(`0x${hex}`))
  return view.getFloat64(0)
}

describe('canonicalize (RFC 8785)', () => {
  test('serializes the §3.2.2 example', () => {
    const input = Schema.decodeUnknownSync(Schema.Json)(
      JSON.parse(
        '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],' +
          '"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/","literals":[null,true,false]}',
      ),
    )
    expect(canonical(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    )
  })

  test('sorts keys by UTF-16 code units (§3.2.3)', () => {
    const input = {
      '\u20ac': 'Euro Sign',
      '\r': 'Carriage Return',
      '\ufb33': 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '\ud83d\ude00': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      '\u00f6': 'Latin Small Letter O With Diaeresis',
    }
    expect(canonical(input)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis",' +
        '"\u20ac":"Euro Sign","\ud83d\ude00":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}',
    )
  })

  // RFC 8785 Appendix B: IEEE 754 bit patterns and their serializations.
  test.each([
    ['0000000000000000', '0'],
    ['8000000000000000', '0'],
    ['0000000000000001', '5e-324'],
    ['8000000000000001', '-5e-324'],
    ['7fefffffffffffff', '1.7976931348623157e+308'],
    ['ffefffffffffffff', '-1.7976931348623157e+308'],
    ['4340000000000000', '9007199254740992'],
    ['c340000000000000', '-9007199254740992'],
    ['4430000000000000', '295147905179352830000'],
    ['44b52d02c7e14af5', '9.999999999999997e+22'],
    ['44b52d02c7e14af6', '1e+23'],
    ['44b52d02c7e14af7', '1.0000000000000001e+23'],
    ['444b1ae4d6e2ef4e', '999999999999999700000'],
    ['444b1ae4d6e2ef4f', '999999999999999900000'],
    ['444b1ae4d6e2ef50', '1e+21'],
    ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
    ['3eb0c6f7a0b5ed8d', '0.000001'],
    ['41b3de4355555553', '333333333.3333332'],
    ['41b3de4355555554', '333333333.33333325'],
    ['41b3de4355555555', '333333333.3333333'],
    ['41b3de4355555556', '333333333.3333334'],
    ['41b3de4355555557', '333333333.33333343'],
    ['becbf647612f3696', '-0.0000033333333333333333'],
    ['43143ff3c1cb0959', '1424953923781206.2'],
  ])('serializes the double %s as %s', (bits, expected) => {
    expect(canonical(fromBits(bits))).toBe(expected)
  })

  test.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['a lone high surrogate', 'a\ud800b'],
    ['a lone low surrogate in a key', { '\udc00': 1 }],
    ['a nested non-finite number', { a: [1, { b: Number.NaN }] }],
  ])('rejects %s', (_name, value) => {
    expect(Result.isFailure(canonicalize(value))).toBe(true)
  })

  test('keeps array order and emits no whitespace', () => {
    expect(canonical({ b: [3, 1, 2], a: { d: null, c: 'x' } })).toBe('{"a":{"c":"x","d":null},"b":[3,1,2]}')
  })

  const WellFormed = Schema.String.check(Schema.isPattern(/^[^\uD800-\uDFFF]*$/u))
  const Entries = Schema.Array(
    Schema.Tuple([WellFormed, Schema.Union([Schema.Finite, WellFormed, Schema.Boolean, Schema.Null])]),
  )

  it.prop('does not depend on key insertion order', [Entries], ([entries]) => {
    const forwards = Object.fromEntries(entries)
    const backwards = Object.fromEntries(Object.entries(forwards).toReversed())
    return canonical(backwards) === canonical(forwards)
  })

  it.prop('is a fixed point: canonicalizing its own output changes nothing', [Entries], ([entries]) => {
    const once = canonical(Object.fromEntries(entries))
    return canonical(Schema.decodeUnknownSync(Schema.Json)(JSON.parse(once))) === once
  })
})
