import { arcTestnet, type SettlementChain } from '@sidequest/settlement/SettlementChain'
import { Option, Redacted } from 'effect'
import { getAddress, type Hex, isAddress, isHex } from 'viem'

/**
 * What settlement runs with: the chain (with the deployed operator, the treasury and the interim arbitrator), the
 * relayer's key and the interim arbitrator's key.
 */
export interface SettlementConfig {
  readonly chain: SettlementChain
  readonly relayerKey: Redacted.Redacted<Hex>
  readonly arbitratorKey: Option.Option<Redacted.Redacted<Hex>>
}

type Environment = Readonly<Record<string, unknown>>

const anAddress = (value: string) => isAddress(value, { strict: false })
const aKey = (value: string): value is Hex => isHex(value) && value.length === 66
const aCount = (value: string) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value))

/**
 * How each settlement variable must read. `SIDEQUEST_ARBITRATION_PUBKEY` and `SIDEQUEST_OPERATOR_DEPLOY_BLOCK` are read
 * by the escrow and the chain log poller (`Escrow/EscrowSettings.ts`). The four before them exist for a local chain
 * (the gate rehearsal on Anvil), whose escrow, collector and stand-in USDC are not at Arc testnet's addresses or
 * domain; a deploy never binds them.
 */
const formats: Readonly<Record<string, (value: string) => boolean>> = {
  SIDEQUEST_OPERATOR_ADDRESS: anAddress,
  SIDEQUEST_TREASURY_ADDRESS: anAddress,
  SIDEQUEST_ARBITRATOR_ADDRESS: anAddress,
  SIDEQUEST_RELAYER_KEY: aKey,
  SIDEQUEST_ARBITRATOR_KEY: aKey,
  SIDEQUEST_CONFIRMATIONS: aCount,
  SIDEQUEST_FEE_BPS: aCount,
  SIDEQUEST_ESCROW_ADDRESS: anAddress,
  SIDEQUEST_COLLECTOR_ADDRESS: anAddress,
  SIDEQUEST_TOKEN_DOMAIN_NAME: (value) => value.length > 0,
  SIDEQUEST_TOKEN_DOMAIN_VERSION: (value) => value.length > 0,
  SIDEQUEST_ARBITRATION_PUBKEY: (value) => /^[0-9a-f]{64}$/u.test(value),
  SIDEQUEST_OPERATOR_DEPLOY_BLOCK: (value) => /^\d{1,15}$/u.test(value),
}

/** The variables settlement cannot run without. */
export const requiredSettlementVariables = [
  'SIDEQUEST_OPERATOR_ADDRESS',
  'SIDEQUEST_TREASURY_ADDRESS',
  'SIDEQUEST_ARBITRATOR_ADDRESS',
  'SIDEQUEST_RELAYER_KEY',
] as const

const text = (environment: Environment, name: string) => {
  const value = environment[name]
  return typeof value === 'string' && value.length > 0 ? Option.some(value) : Option.none()
}
const valid = (environment: Environment, name: string) =>
  Option.filter(text(environment, name), (value) => formats[name]?.(value) === true)

/** The settlement variables `environment` sets that do not read as they must (names only, never values). */
export const malformedSettlementVariables = (environment: Environment) =>
  Object.keys(formats).filter(
    (name) => Option.isSome(text(environment, name)) && Option.isNone(valid(environment, name)),
  )

const keyOf = (environment: Environment, name: string) =>
  Option.map(Option.filter(valid(environment, name), aKey), (value) => Redacted.make(value))
const countOf = (environment: Environment, name: string) =>
  Option.getOrUndefined(Option.map(valid(environment, name), Number))

/** Arc testnet, or the local chain the overrides describe. */
const chainOf = (environment: Environment, deployment: Parameters<typeof arcTestnet>[0]): SettlementChain => {
  const chain = arcTestnet(deployment)
  const escrow = Option.getOrUndefined(Option.map(valid(environment, 'SIDEQUEST_ESCROW_ADDRESS'), getAddress))
  const collector = Option.getOrUndefined(Option.map(valid(environment, 'SIDEQUEST_COLLECTOR_ADDRESS'), getAddress))
  const name = Option.getOrUndefined(valid(environment, 'SIDEQUEST_TOKEN_DOMAIN_NAME'))
  const version = Option.getOrUndefined(valid(environment, 'SIDEQUEST_TOKEN_DOMAIN_VERSION'))
  return {
    ...chain,
    escrow: escrow ?? chain.escrow,
    collector: collector ?? chain.collector,
    tokenDomain: { name: name ?? chain.tokenDomain.name, version: version ?? chain.tokenDomain.version },
  }
}

/**
 * Settlement's configuration from the Worker's environment, if it is complete. Until `SIDEQUEST_OPERATOR_ADDRESS`,
 * `SIDEQUEST_TREASURY_ADDRESS`, `SIDEQUEST_ARBITRATOR_ADDRESS` and the secret `SIDEQUEST_RELAYER_KEY` are all set,
 * there is none: the escrow endpoints answer `Unavailable`, and the settler and the chain log poller do nothing.
 * Optional: `SIDEQUEST_FEE_BPS` (500), `SIDEQUEST_CONFIRMATIONS` (3) and the secret `SIDEQUEST_ARBITRATOR_KEY`. A stage
 * binds them from the deploying shell (`SettlementStage.ts`).
 */
export const settlementConfigFrom = (environment: Environment): Option.Option<SettlementConfig> =>
  Option.map(
    Option.all({
      operator: valid(environment, 'SIDEQUEST_OPERATOR_ADDRESS'),
      feeReceiver: valid(environment, 'SIDEQUEST_TREASURY_ADDRESS'),
      arbitrator: valid(environment, 'SIDEQUEST_ARBITRATOR_ADDRESS'),
      relayerKey: keyOf(environment, 'SIDEQUEST_RELAYER_KEY'),
    }),
    ({ relayerKey, ...deployment }) => {
      const feeBps = countOf(environment, 'SIDEQUEST_FEE_BPS')
      const confirmations = countOf(environment, 'SIDEQUEST_CONFIRMATIONS')
      return {
        chain: chainOf(environment, {
          ...deployment,
          ...(feeBps === undefined ? {} : { feeBps }),
          ...(confirmations === undefined ? {} : { confirmations }),
        }),
        relayerKey,
        arbitratorKey: keyOf(environment, 'SIDEQUEST_ARBITRATOR_KEY'),
      }
    },
  )
