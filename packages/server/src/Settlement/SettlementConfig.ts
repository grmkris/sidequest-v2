import {
  type ChainProfile,
  type ChainRefusal,
  chainProfileOf,
  chainRefusal,
  ChainName,
  settlementChainOn,
} from '@sidequest/settlement/Chains'
import type { ArcTestnetDeployment, SettlementChain } from '@sidequest/settlement/SettlementChain'
import { Option, Redacted, Schema } from 'effect'
import { getAddress, type Hex, isAddress, isAddressEqual, isHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

/**
 * What settlement runs with: the chain (with the deployed operator, the treasury and the interim arbitrator), the
 * relayer's key and the interim arbitrator's key.
 */
export interface SettlementConfig {
  readonly chain: SettlementChain
  /** The chain's profile: whether it is a mainnet, its public RPC, the relayer balance below which the stage warns. */
  readonly profile: ChainProfile
  readonly relayerKey: Redacted.Redacted<Hex>
  readonly arbitratorKey: Option.Option<Redacted.Redacted<Hex>>
  /** Below this relayer balance (the chain's native unit, in wei) the stage warns; the profile's unless set. */
  readonly lowRelayerBalance: bigint
}

type Environment = Readonly<Record<string, unknown>>

const anAddress = (value: string) => isAddress(value, { strict: false })
const aKey = (value: string): value is Hex => isHex(value) && value.length === 66
const aCount = (value: string) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value))
const anAmount = (value: string) => /^\d{1,30}$/u.test(value)
const pubkeyList = (value: string) => value.split(',').every((key) => /^[0-9a-f]{64}$/u.test(key.trim()))

/**
 * How each settlement variable must read. `SIDEQUEST_ARBITRATION_PUBKEY` and `SIDEQUEST_OPERATOR_DEPLOY_BLOCK` are read
 * by the escrow and the chain log poller (`Escrow/EscrowSettings.ts`), the launch caps by the escrow's funding rules
 * (`Escrow/LaunchCaps.ts`). `SIDEQUEST_ESCROW_ADDRESS` to `SIDEQUEST_TOKEN_DOMAIN_VERSION` exist for a local chain
 * (the gate rehearsal on Anvil), whose escrow, collector and stand-in USDC are not at the named chain's addresses or
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
  SIDEQUEST_CHAIN: (value) => Option.isSome(Schema.decodeUnknownOption(ChainName)(value)),
  SIDEQUEST_ALLOW_MAINNET: (value) => value.length > 0,
  SIDEQUEST_RELAYER_LOW_BALANCE_WEI: anAmount,
  SIDEQUEST_CAP_MAX_JOB_AMOUNT: anAmount,
  SIDEQUEST_CAP_ALLOWED_PUBKEYS: pubkeyList,
  SIDEQUEST_CAP_DAILY_GAS_WEI: anAmount,
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

const addressOfKey = (key: Hex) => privateKeyToAccount(key).address

/**
 * The keys that disagree with the addresses beside them: the arbitrator's key must be the arbitrator's address's (or
 * every ruling it signs is refused on chain), and the relayer must not be the arbitrator, because the contract accepts
 * a ruling from the arbitrator's own call, so a relayer that is the arbitrator could rule by relaying.
 */
const disagreeingKeys = (environment: Environment) => {
  const arbitrator = Option.getOrUndefined(valid(environment, 'SIDEQUEST_ARBITRATOR_ADDRESS'))
  if (arbitrator === undefined) return []
  const named = (name: string) =>
    Option.match(Option.filter(valid(environment, name), aKey), {
      onNone: () => false,
      onSome: (key) => isAddressEqual(addressOfKey(key), getAddress(arbitrator)),
    })
  const arbitratorKeyWrong = Option.isSome(valid(environment, 'SIDEQUEST_ARBITRATOR_KEY'))
    ? !named('SIDEQUEST_ARBITRATOR_KEY')
    : false
  return [
    ...(arbitratorKeyWrong ? ['SIDEQUEST_ARBITRATOR_KEY'] : []),
    ...(named('SIDEQUEST_RELAYER_KEY') ? ['SIDEQUEST_RELAYER_KEY'] : []),
  ]
}

/** The settlement variables `environment` sets that do not read as they must (names only, never values). */
export const malformedSettlementVariables = (environment: Environment) => [
  ...Object.keys(formats).filter(
    (name) => Option.isSome(text(environment, name)) && Option.isNone(valid(environment, name)),
  ),
  ...disagreeingKeys(environment),
]

/** The chain profile `SIDEQUEST_CHAIN` names (Arc testnet when unset), if it names a known one. */
export const chainProfileFrom = (environment: Environment) =>
  chainProfileOf(Option.filter(text(environment, 'SIDEQUEST_CHAIN'), (name) => name.length > 0))

/**
 * Why this stage may not settle on its chain, if it may not: a mainnet without its exact `SIDEQUEST_ALLOW_MAINNET`
 * phrase (`mainnetOptIn` in `@sidequest/settlement/Chains`), or a chain where the escrow is not deployed. Read at
 * deploy (`SettlementStage.ts`) and again by the Worker, so neither alone lets a stage move real money.
 */
export const settlementChainRefusal = (environment: Environment): ChainRefusal | undefined =>
  Option.match(chainProfileFrom(environment), {
    onNone: () => undefined,
    onSome: (profile) =>
      chainRefusal(
        profile,
        Option.getOrElse(text(environment, 'SIDEQUEST_ALLOW_MAINNET'), () => ''),
      ),
  })

const keyOf = (environment: Environment, name: string) =>
  Option.map(Option.filter(valid(environment, name), aKey), (value) => Redacted.make(value))
const countOf = (environment: Environment, name: string) =>
  Option.getOrUndefined(Option.map(valid(environment, name), Number))

/** The named chain, or the local chain the overrides describe. */
const chainOf = (
  environment: Environment,
  profile: ChainProfile,
  deployment: ArcTestnetDeployment,
): Option.Option<SettlementChain> =>
  Option.map(settlementChainOn(profile, deployment), (chain) => {
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
  })

/**
 * Settlement's configuration from the Worker's environment, if it is complete and allowed. Until
 * `SIDEQUEST_OPERATOR_ADDRESS`, `SIDEQUEST_TREASURY_ADDRESS`, `SIDEQUEST_ARBITRATOR_ADDRESS` and the secret
 * `SIDEQUEST_RELAYER_KEY` are all set, there is none: the escrow endpoints answer `Unavailable`, and the settler and
 * the chain log poller do nothing. There is none either on a chain the stage may not settle on
 * (`settlementChainRefusal`), or when a key disagrees with its address. Optional: `SIDEQUEST_CHAIN` (`arc-testnet`),
 * `SIDEQUEST_FEE_BPS` (500), `SIDEQUEST_CONFIRMATIONS` (the chain's), `SIDEQUEST_RELAYER_LOW_BALANCE_WEI` (the
 * chain's) and the secret `SIDEQUEST_ARBITRATOR_KEY`. A stage binds them from the deploying shell
 * (`SettlementStage.ts`).
 */
export const settlementConfigFrom = (environment: Environment): Option.Option<SettlementConfig> => {
  if (settlementChainRefusal(environment) !== undefined || disagreeingKeys(environment).length > 0) return Option.none()
  return Option.flatMap(
    Option.all({
      profile: chainProfileFrom(environment),
      operator: valid(environment, 'SIDEQUEST_OPERATOR_ADDRESS'),
      feeReceiver: valid(environment, 'SIDEQUEST_TREASURY_ADDRESS'),
      arbitrator: valid(environment, 'SIDEQUEST_ARBITRATOR_ADDRESS'),
      relayerKey: keyOf(environment, 'SIDEQUEST_RELAYER_KEY'),
    }),
    ({ relayerKey, profile, ...deployment }) => {
      const feeBps = countOf(environment, 'SIDEQUEST_FEE_BPS')
      const confirmations = countOf(environment, 'SIDEQUEST_CONFIRMATIONS')
      const chain = chainOf(environment, profile, {
        ...deployment,
        ...(feeBps === undefined ? {} : { feeBps }),
        ...(confirmations === undefined ? {} : { confirmations }),
      })
      const lowBalance = Option.map(valid(environment, 'SIDEQUEST_RELAYER_LOW_BALANCE_WEI'), BigInt)
      return Option.map(chain, (on) => ({
        chain: on,
        profile,
        relayerKey,
        arbitratorKey: keyOf(environment, 'SIDEQUEST_ARBITRATOR_KEY'),
        lowRelayerBalance: Option.getOrElse(lowBalance, () => profile.lowRelayerBalance),
      }))
    },
  )
}
