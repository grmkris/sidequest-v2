import { readFileSync } from 'node:fs'
import { Option } from 'effect'
import { decodeFunctionData, parseAbi } from 'viem'
import { describe, expect, test } from 'vitest'
import { erc8004IdentityAbi, erc8004ReputationAbi } from '../src/abi/Erc8004.ts'
import { erc8004RegistriesOn, giveFeedbackCalldata, registerCalldata } from '../src/Erc8004.ts'

// The ERC-8004 text at ethereum/ERCs 503591a, vendored once, in the protocol package (`tools/provenance.json`).
const spec = readFileSync(new URL('../../protocol/test/vectors/erc-8004.md', import.meta.url), 'utf8')
const declarations = [...spec.matchAll(/```solidity\n([\s\S]*?)```/gu)]
  .flatMap((match) => (match[1] ?? '').split('\n'))
  .map((line) => line.trim())
  .filter((line) => line.startsWith('function ') || line.startsWith('event '))

const struct = 'struct MetadataEntry { string metadataKey; bytes metadataValue; }'
const ours = [...erc8004IdentityAbi, ...erc8004ReputationAbi]
const validation = /validator|Validation|validationRe/u

describe('the ERC-8004 ABI', () => {
  test('declares every identity and reputation function and event exactly as the specification writes it', () => {
    const declared = declarations.filter((line) => !validation.test(line))
    expect(declared.length).toBe(25)
    for (const line of declared) {
      const signatures: ReadonlyArray<string> = [struct, line]
      const [item] = parseAbi(signatures)
      expect(ours).toContainEqual(item)
    }
  })

  test('encodes register and giveFeedback as a wallet sends them', () => {
    const register = decodeFunctionData({ abi: erc8004IdentityAbi, data: registerCalldata('https://x.test/a') })
    expect(register).toEqual({ functionName: 'register', args: ['https://x.test/a'] })
    const feedback = decodeFunctionData({
      abi: erc8004ReputationAbi,
      data: giveFeedbackCalldata({
        agentId: 7n,
        value: 80n,
        valueDecimals: 0,
        tag1: 'starred',
        tag2: 'sidequest',
        endpoint: '',
        feedbackUri: 'https://x.test/f',
        feedbackHash: `0x${'ab'.repeat(32)}`,
      }),
    })
    expect(feedback.args).toEqual([7n, 80n, 0, 'starred', 'sidequest', '', 'https://x.test/f', `0x${'ab'.repeat(32)}`])
  })

  test('knows the registries on Arc testnet and Arc, and none on a chain where none was read', () => {
    expect(Option.map(erc8004RegistriesOn(5_042_002), ({ identity }) => identity)).toEqual(
      Option.some('0x8004A818BFB912233c491871b3d84c89A494BD9e'),
    )
    expect(Option.map(erc8004RegistriesOn(5042), ({ reputation }) => reputation)).toEqual(
      Option.some('0x8004BAa17C55a88189AE136b182e5fdA19dE9b63'),
    )
    expect(erc8004RegistriesOn(31_337)).toEqual(Option.none())
  })
})
