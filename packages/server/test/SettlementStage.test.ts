import { it } from '@effect/vitest'
import { Effect, Option, Redacted } from 'effect'
import { ConfigProvider } from 'effect'
import { describe, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { settlementConfigFrom } from '../src/Settlement/SettlementConfig.ts'
import { settlementVariablesFromShell } from '../src/Settlement/SettlementStage.ts'

// What a stage binds for settlement, read from the deploying shell: nothing when nothing is set, everything (keys as
// secrets) when all of it is, and a refused deploy, naming what to fix but never a value, when it is half set.

const relayerKey = `0x${'5a'.repeat(32)}` as const
const arbitratorKey = `0x${'6b'.repeat(32)}` as const
const complete = {
  SIDEQUEST_OPERATOR_ADDRESS: '0x00000000000000000000000000000000000000a1',
  SIDEQUEST_TREASURY_ADDRESS: '0x00000000000000000000000000000000000000a2',
  SIDEQUEST_ARBITRATOR_ADDRESS: privateKeyToAccount(arbitratorKey).address,
  SIDEQUEST_RELAYER_KEY: relayerKey,
  SIDEQUEST_ARBITRATOR_KEY: arbitratorKey,
  SIDEQUEST_ARBITRATION_PUBKEY: 'ab'.repeat(32),
  SIDEQUEST_CONFIRMATIONS: '1',
}

const fromShell = (env: Record<string, string>) =>
  settlementVariablesFromShell.pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
  )

/** What the Worker sees of what a stage bound: secrets as text in its environment. */
const workerSees = (bound: Readonly<Record<string, string | Redacted.Redacted>>) =>
  Object.fromEntries(
    Object.entries(bound).map(([name, value]) => [name, Redacted.isRedacted(value) ? Redacted.value(value) : value]),
  )

describe('settlement from the deploying shell', () => {
  it.effect('binds nothing when nothing is set, so settlement stays disabled', () =>
    Effect.gen(function* () {
      const bound = yield* fromShell({ PATH: '/usr/bin' })
      expect(bound).toEqual({})
      expect(settlementConfigFrom(bound)).toEqual(Option.none())
    }),
  )

  it.effect('binds the keys as secrets and the rest as text, which the Worker reads back as its configuration', () =>
    Effect.gen(function* () {
      const bound = yield* fromShell(complete)
      expect(Redacted.isRedacted(bound['SIDEQUEST_RELAYER_KEY'])).toBe(true)
      expect(Redacted.isRedacted(bound['SIDEQUEST_ARBITRATOR_KEY'])).toBe(true)
      expect(bound['SIDEQUEST_OPERATOR_ADDRESS']).toBe(complete.SIDEQUEST_OPERATOR_ADDRESS)
      expect(JSON.stringify(bound)).not.toContain('5a5a')
      const worker = workerSees(bound)
      const config = Option.getOrThrow(settlementConfigFrom(worker))
      expect(config.chain).toMatchObject({ chainId: 5042002, confirmations: 1, feeBps: 500 })
      expect(Redacted.value(config.relayerKey)).toBe(relayerKey)
      expect(Option.map(config.arbitratorKey, Redacted.value)).toEqual(Option.some(arbitratorKey))
      expect(worker['SIDEQUEST_ARBITRATION_PUBKEY']).toBe(complete.SIDEQUEST_ARBITRATION_PUBKEY)
    }),
  )

  it.effect('refuses a half-configured stage, naming what is missing or malformed and never a value', () =>
    Effect.gen(function* () {
      const { SIDEQUEST_TREASURY_ADDRESS: _, ...withoutTreasury } = complete
      const missing = yield* Effect.flip(fromShell({ ...withoutTreasury, SIDEQUEST_RELAYER_KEY: '0x5a5a' }))
      expect(missing.message).toContain('SIDEQUEST_TREASURY_ADDRESS')
      expect(missing.message).toContain('SIDEQUEST_RELAYER_KEY')
      expect(missing.message).not.toContain('0x5a5a')
      const arbitration = yield* Effect.flip(fromShell({ ...complete, SIDEQUEST_ARBITRATION_PUBKEY: 'cy' }))
      expect(arbitration.message).toContain('SIDEQUEST_ARBITRATION_PUBKEY')
    }),
  )

  it.effect('refuses a key that disagrees with its address, and a relayer that is the arbitrator', () =>
    Effect.gen(function* () {
      const wrongKey = yield* Effect.flip(fromShell({ ...complete, SIDEQUEST_ARBITRATOR_KEY: `0x${'7c'.repeat(32)}` }))
      expect(wrongKey.message).toContain('SIDEQUEST_ARBITRATOR_KEY')
      const relayerRules = yield* Effect.flip(fromShell({ ...complete, SIDEQUEST_RELAYER_KEY: arbitratorKey }))
      expect(relayerRules.message).toContain('SIDEQUEST_RELAYER_KEY')
      expect(settlementConfigFrom({ ...complete, SIDEQUEST_RELAYER_KEY: arbitratorKey })).toEqual(Option.none())
    }),
  )
})

describe('a stage on a mainnet', () => {
  const onBase = { ...complete, SIDEQUEST_CHAIN: 'base-mainnet' }
  const phrase = 'settle real money on base-mainnet (chain 8453)'

  it.effect('is refused at deploy without the exact phrase, which the refusal names', () =>
    Effect.gen(function* () {
      const refused = yield* Effect.flip(fromShell(onBase))
      expect(refused.message).toContain('chainRefused')
      expect(refused.message).toContain(phrase)
      const wrong = yield* Effect.flip(fromShell({ ...onBase, SIDEQUEST_ALLOW_MAINNET: 'yes' }))
      expect(wrong.message).toContain('chainRefused')
      const unknown = yield* Effect.flip(fromShell({ ...complete, SIDEQUEST_CHAIN: 'base-sepolia' }))
      expect(unknown.message).toContain('SIDEQUEST_CHAIN')
    }),
  )

  it('is refused by the Worker too, whatever was bound: neither key alone moves real money', () => {
    expect(settlementConfigFrom(onBase)).toEqual(Option.none())
    expect(settlementConfigFrom({ ...onBase, SIDEQUEST_ALLOW_MAINNET: 'yes' })).toEqual(Option.none())
  })

  it.effect('settles on Base mainnet with the phrase, on its USDC and its confirmations', () =>
    Effect.gen(function* () {
      const bound = yield* fromShell({ ...onBase, SIDEQUEST_ALLOW_MAINNET: phrase, SIDEQUEST_CONFIRMATIONS: '12' })
      const worker = workerSees(bound)
      const config = Option.getOrThrow(settlementConfigFrom(worker))
      expect(config.chain).toMatchObject({ chainId: 8453, confirmations: 12, tokenDomain: { name: 'USD Coin' } })
      expect(config.profile.mainnet).toBe(true)
    }),
  )

  it.effect('is refused on Arc mainnet even with its phrase: the escrow is not deployed there', () =>
    Effect.gen(function* () {
      const refused = yield* Effect.flip(
        fromShell({
          ...complete,
          SIDEQUEST_CHAIN: 'arc-mainnet',
          SIDEQUEST_ALLOW_MAINNET: 'settle real money on arc-mainnet (chain 5042)',
        }),
      )
      expect(refused.message).toContain('escrow is not deployed on arc-mainnet')
    }),
  )
})
