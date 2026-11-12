import { Option, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { AccountRef } from '../src/AccountRef.ts'
import { AssetId, AssetRef } from '../src/AssetRef.ts'
import { findAsset, UsdcOnArcTestnet } from '../src/AssetRegistry.ts'
import { NetworkRef } from '../src/NetworkRef.ts'

const accepts = (schema: Schema.Codec<unknown, string>, input: string) =>
  Option.isSome(Schema.decodeUnknownOption(schema)(input))

describe('NetworkRef (CAIP-2)', () => {
  test.each([
    'eip155:5042002',
    'eip155:1',
    'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    'bip122:000000000019d6689c085ae165831e93',
  ])('accepts %s', (input) => expect(accepts(NetworkRef, input)).toBe(true))
  test.each(['eip155', ':1', 'ab:1', 'EIP155:1', 'toolongns:1', 'eip155:', `eip155:${'1'.repeat(33)}`, 'eip155:1/x'])(
    'rejects %s',
    (input) => expect(accepts(NetworkRef, input)).toBe(false),
  )
})

describe('AccountRef (CAIP-10)', () => {
  test.each([
    'eip155:5042002:0xab16a96D359eC26a11e2C2b3d8f8B8942d5Bfcdb',
    'eip155:1:0x0000000000000000000000000000000000000000',
  ])('accepts %s', (input) => expect(accepts(AccountRef, input)).toBe(true))
  test.each([
    'eip155:5042002',
    '0xab16a96D359eC26a11e2C2b3d8f8B8942d5Bfcdb',
    'eip155:5042002:',
    'eip155:1:0x ab',
    `eip155:1:${'a'.repeat(129)}`,
  ])('rejects %s', (input) => expect(accepts(AccountRef, input)).toBe(false))
})

describe('AssetId (CAIP-19)', () => {
  test.each([
    'eip155:5042002/erc20:0x3600000000000000000000000000000000000000',
    'eip155:1/slip44:60',
    'eip155:1/erc721:0x06012c8cf97BEaD5deAe237070F9587f8E7A266d/771769',
  ])('accepts %s', (input) => expect(accepts(AssetId, input)).toBe(true))
  test.each([
    'eip155:5042002',
    'eip155:5042002/erc20',
    'eip155:5042002/ERC20:0x36',
    'eip155:5042002:erc20:0x36',
    '/erc20:0x36',
    'eip155:1/erc721:0x06/771769/1',
  ])('rejects %s', (input) => expect(accepts(AssetId, input)).toBe(false))
})

describe('the asset registry', () => {
  test('holds USDC on Arc testnet with its verified chain id, address and decimals', () => {
    expect(Schema.encodeSync(AssetRef)(UsdcOnArcTestnet)).toStrictEqual({
      id: 'eip155:5042002/erc20:0x3600000000000000000000000000000000000000',
      network: 'eip155:5042002',
      decimals: 6,
      symbol: 'USDC',
    })
  })

  test('finds registered assets and nothing else', () => {
    const decodeId = Schema.decodeSync(AssetId)
    expect(findAsset(decodeId('eip155:5042002/erc20:0x3600000000000000000000000000000000000000'))).toStrictEqual(
      Option.some(UsdcOnArcTestnet),
    )
    expect(Option.isNone(findAsset(decodeId('eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')))).toBe(
      true,
    )
  })

  test('rejects an asset ref whose id is on another network', () => {
    const decoded = Schema.decodeUnknownOption(AssetRef)({
      ...Schema.encodeSync(AssetRef)(UsdcOnArcTestnet),
      network: 'eip155:5042',
    })
    expect(Option.isNone(decoded)).toBe(true)
  })
})
