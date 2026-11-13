import { Option, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import {
  Erc8004Feedback,
  Erc8004RegistrationFile,
  erc8004RegistrationType,
  SidequestRegistrationFile,
} from '../src/Erc8004.ts'
import { Person } from '../src/EventsApi.ts'
import { specExamples } from './Erc8004Spec.ts'

describe('ERC-8004’s shapes, read against the specification’s own examples', () => {
  test('the registration file example is an `Erc8004RegistrationFile`, services and registrations included', () => {
    const file = Schema.decodeUnknownSync(Erc8004RegistrationFile)(specExamples[0])
    expect(file.type).toBe(erc8004RegistrationType)
    expect(file.services.map((service) => service.name)).toEqual(['web', 'A2A', 'MCP', 'OASF', 'ENS', 'DID', 'email'])
    expect(file.registrations).toEqual([{ agentId: 22, agentRegistry: '{namespace}:{chainId}:{identityRegistry}' }])
    expect(file.supportedTrust).toEqual(['reputation', 'crypto-economic', 'tee-attestation'])
  })

  test('the feedback file example is an `Erc8004Feedback`, with its proof of payment', () => {
    const feedback = Schema.decodeUnknownSync(Erc8004Feedback)(specExamples[1])
    expect(feedback).toMatchObject({ agentId: 22, value: 100, valueDecimals: 0, tag1: 'foo', tag2: 'bar' })
    expect(feedback.proofOfPayment?.chainId).toBe('1')
  })

  test('refuses a registration file of another type, or with the earlier draft’s `endpoints` alone', () => {
    const example = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(specExamples[0])
    const decode = Schema.decodeUnknownOption(Erc8004RegistrationFile)
    expect(Option.isSome(decode(example))).toBe(true)
    expect(decode({ ...example, type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v0' })).toEqual(
      Option.none(),
    )
    const { services, ...rest } = example
    expect(decode({ ...rest, endpoints: services })).toEqual(Option.none())
  })

  test('Sidequest’s registration file is the specification’s with its own facts beside', () => {
    const example = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(specExamples[0])
    const served = Schema.decodeUnknownSync(SidequestRegistrationFile)({
      ...example,
      sidequest: { pubkey: '11'.repeat(32), feedback: 'https://sidequest.test/f' },
    })
    expect(Schema.is(Erc8004RegistrationFile)(served)).toBe(true)
  })

  test('a person served before identities existed reads with none', () => {
    const person = Schema.decodeUnknownSync(Person)({
      pubkey: '11'.repeat(32),
      profile: null,
      relays: null,
      messagingRelays: null,
      wallets: [],
      unverifiedWallets: [],
      agents: [],
      operators: [],
    })
    expect(person.erc8004).toEqual([])
  })
})
