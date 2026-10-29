import { describe, expect, test } from 'vitest'
import { contractFor, flatten, validateCatalogs } from './catalog.ts'

describe('catalog acceptance', () => {
  test('rejects missing keys, malformed ICU, empty text and variable drift', () => {
    expect(() => validateCatalogs({ hello: 'Hi' }, {})).toThrow('key parity')
    expect(() => contractFor('en', 'bad', '{count, plural')).toThrow('EXPECT_SELECT_ARGUMENT_OPTIONS')
    expect(() => flatten({ empty: '' })).toThrow('Empty message')
    expect(() => flatten({ number: 1 })).toThrow('Invalid catalog node')
    expect(() => validateCatalogs({ hello: 'Hi {name}' }, { hello: 'Živjo {user}' })).toThrow('Argument parity')
  })

  test('requires Slovenian dual/few and allows only approved rich tags', () => {
    expect(() => contractFor('sl', 'new', '{n, plural, one {kos} other {kosi}}')).toThrow('Missing plural')
    expect(() => contractFor('en', 'unsafe', '<script>hello</script>')).toThrow('Unapproved rich tag')
    expect(() => validateCatalogs({ text: '<italic>Hello</italic>' }, { text: 'Živjo' })).toThrow('Argument parity')
  })

  test('uses the strictest numeric contract when translations omit plural syntax', () => {
    const contracts = validateCatalogs({ count: '{n, plural, one {#} other {#}}' }, { count: '{n}' })
    expect(contracts.get('count')?.get('n')).toBe('number')
  })
})
