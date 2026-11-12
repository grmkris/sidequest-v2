import { it } from '@effect/vitest'
import { Effect, Option, Redacted } from 'effect'
import { ConfigProvider } from 'effect'
import { describe, expect } from 'vitest'
import { escrowConfigFrom } from '../src/Settlement/EscrowConfig.ts'
import { settlementVariablesFromShell } from '../src/Settlement/SettlementStage.ts'

// What a stage binds for settlement, read from the deploying shell: nothing when nothing is set, everything (keys as
// secrets) when all of it is, and a refused deploy, naming what to fix but never a value, when it is half set.

const relayerKey = `0x${'5a'.repeat(32)}`
const arbitratorKey = `0x${'6b'.repeat(32)}`
const complete = {
  SIDEQUEST_OPERATOR_ADDRESS: '0x00000000000000000000000000000000000000a1',
  SIDEQUEST_TREASURY_ADDRESS: '0x00000000000000000000000000000000000000a2',
  SIDEQUEST_ARBITRATOR_ADDRESS: '0x00000000000000000000000000000000000000a3',
  SIDEQUEST_RELAYER_KEY: relayerKey,
  SIDEQUEST_ARBITRATOR_KEY: arbitratorKey,
  SIDEQUEST_ARBITRATION_OPERATOR: 'account_01JCXZ4Q6N8M2V7T3R5W9Y0B1Z',
  SIDEQUEST_CONFIRMATIONS: '1',
}

const fromShell = (env: Record<string, string>) =>
  settlementVariablesFromShell.pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
  )

describe('settlement from the deploying shell', () => {
  it.effect('binds nothing when nothing is set, so settlement stays disabled', () =>
    Effect.gen(function* () {
      const bound = yield* fromShell({ PATH: '/usr/bin' })
      expect(bound).toEqual({})
      expect(escrowConfigFrom(bound)).toEqual(Option.none())
    }),
  )

  it.effect('binds the keys as secrets and the rest as text, which the Worker reads back as its configuration', () =>
    Effect.gen(function* () {
      const bound = yield* fromShell(complete)
      expect(Redacted.isRedacted(bound['SIDEQUEST_RELAYER_KEY'])).toBe(true)
      expect(Redacted.isRedacted(bound['SIDEQUEST_ARBITRATOR_KEY'])).toBe(true)
      expect(bound['SIDEQUEST_OPERATOR_ADDRESS']).toBe(complete.SIDEQUEST_OPERATOR_ADDRESS)
      expect(JSON.stringify(bound)).not.toContain('5a5a')
      // The Worker sees secrets as text in its environment.
      const worker = Object.fromEntries(
        Object.entries(bound).map(([name, value]) => [
          name,
          Redacted.isRedacted(value) ? Redacted.value(value) : value,
        ]),
      )
      const config = Option.getOrThrow(escrowConfigFrom(worker))
      expect(config.chain).toMatchObject({ chainId: 5042002, confirmations: 1, feeBps: 500 })
      expect(Redacted.value(config.relayerKey)).toBe(relayerKey)
      expect(Option.map(config.arbitratorKey, Redacted.value)).toEqual(Option.some(arbitratorKey))
      expect(config.arbitrationOperator).toEqual(Option.some(complete.SIDEQUEST_ARBITRATION_OPERATOR))
    }),
  )

  it.effect('refuses a half-configured stage, naming what is missing or malformed and never a value', () =>
    Effect.gen(function* () {
      const { SIDEQUEST_TREASURY_ADDRESS: _, ...withoutTreasury } = complete
      const missing = yield* Effect.flip(fromShell({ ...withoutTreasury, SIDEQUEST_RELAYER_KEY: '0x5a5a' }))
      expect(missing.message).toContain('SIDEQUEST_TREASURY_ADDRESS')
      expect(missing.message).toContain('SIDEQUEST_RELAYER_KEY')
      expect(missing.message).not.toContain('0x5a5a')
      const operator = yield* Effect.flip(fromShell({ ...complete, SIDEQUEST_ARBITRATION_OPERATOR: 'cy' }))
      expect(operator.message).toContain('SIDEQUEST_ARBITRATION_OPERATOR')
    }),
  )
})
