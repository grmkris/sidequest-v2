import { AssetRef, UsdcOnArcTestnet } from '@sidequest/protocol'
import { Option, Schema } from 'effect'
import { type Address, getAddress } from 'viem'
import {
  type ArcTestnetDeployment,
  arcTestnetCollector,
  arcTestnetEscrow,
  arcTestnetUsdcDomain,
  type SettlementChain,
} from './SettlementChain.ts'

/** The chains a stage can name in `SIDEQUEST_CHAIN`. Only `arc-testnet` settles today; the mainnets are refused. */
export const ChainName = Schema.Literals(['arc-testnet', 'arc-mainnet', 'base-mainnet'])
export type ChainName = typeof ChainName.Type

/**
 * Everything about a settlement chain that does not depend on Sidequest's own deployment: its id, whether real money
 * moves on it, its USDC and that token's EIP-712 domain, Coinbase's commerce-payments v1.1 contracts where they are
 * deployed (and their bytecode checked against the vendored build), how many confirmations make an event count, its
 * public RPC endpoint (a stage on a mainnet names a paid one), and the relayer balance below which the stage warns.
 * `checked` says when and how the values were verified.
 */
export interface ChainProfile {
  readonly name: ChainName
  readonly chainId: number
  readonly mainnet: boolean
  readonly asset: AssetRef
  readonly tokenDomain: { readonly name: string; readonly version: string }
  readonly commercePayments: Option.Option<{ readonly escrow: Address; readonly collector: Address }>
  readonly confirmations: number
  readonly publicRpcUrl: string
  /** In the chain's native unit's smallest denomination (wei; on Arc, USDC with 18 decimals). */
  readonly lowRelayerBalance: bigint
  readonly checked: string
}

const usdcOn = (network: string, address: string) =>
  Schema.decodeSync(AssetRef)({ id: `${network}/erc20:${address}`, network, decimals: 6, symbol: 'USDC' })

/** The canonical commerce-payments v1.1.0 addresses, the same on every chain it is deployed on (CREATE2). */
const canonical = { escrow: arcTestnetEscrow, collector: arcTestnetCollector }

/** The chains, by name. Values verified on 2026-11-13 (docs/MAINNET-READINESS.md, "External facts"). */
export const chainProfiles: Readonly<Record<ChainName, ChainProfile>> = {
  'arc-testnet': {
    name: 'arc-testnet',
    chainId: 5042002,
    mainnet: false,
    asset: UsdcOnArcTestnet,
    tokenDomain: arcTestnetUsdcDomain,
    commercePayments: Option.some(canonical),
    confirmations: 3,
    publicRpcUrl: 'https://rpc.testnet.arc.io',
    lowRelayerBalance: 1_000_000_000_000_000_000n,
    checked: 'fork test test/fork/ArcTestnet.fork.t.sol; USDC domain read on chain 2026-11-12',
  },
  // Arc mainnet is live (since 2026-09-16, chain 5042), but commerce-payments is not deployed on it: no code at the
  // canonical escrow, collector or token store on 2026-11-13. A stage cannot settle there until it is, and its
  // bytecode is checked as the Arc testnet fork test checks testnet's.
  'arc-mainnet': {
    name: 'arc-mainnet',
    chainId: 5042,
    mainnet: true,
    asset: usdcOn('eip155:5042', '0x3600000000000000000000000000000000000000'),
    tokenDomain: { name: 'USDC', version: '2' },
    commercePayments: Option.none(),
    confirmations: 3,
    publicRpcUrl: 'https://rpc.mainnet.arc.io',
    lowRelayerBalance: 5_000_000_000_000_000_000n,
    checked: 'docs.arc.io and eth_getCode on rpc.mainnet.arc.io, 2026-11-13',
  },
  // Base mainnet USDC's domain name is "USD Coin", not "USDC" as on Arc and Base Sepolia.
  'base-mainnet': {
    name: 'base-mainnet',
    chainId: 8453,
    mainnet: true,
    asset: usdcOn('eip155:8453', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
    tokenDomain: { name: 'USD Coin', version: '2' },
    commercePayments: Option.some(canonical),
    confirmations: 10,
    publicRpcUrl: 'https://mainnet.base.org',
    lowRelayerBalance: 5_000_000_000_000_000n,
    checked: 'fork test test/fork/BaseMainnet.fork.t.sol (bytecode, USDC domain), 2026-11-13',
  },
}

/**
 * The phrase that, set as `SIDEQUEST_ALLOW_MAINNET`, lets a stage settle on a mainnet: it names the chain, so a phrase
 * copied from another stage's shell opts in to nothing else.
 */
export const mainnetOptIn = (profile: ChainProfile) => `settle real money on ${profile.name} (chain ${profile.chainId})`

/** Why a stage may not settle on a chain: a mainnet without its exact opt-in, or no escrow deployed there. */
export type ChainRefusal = 'MainnetNotOptedIn' | 'EscrowNotDeployed'

/** Whether a stage may settle on `profile` with `optIn` as its `SIDEQUEST_ALLOW_MAINNET` (empty when unset). */
export const chainRefusal = (profile: ChainProfile, optIn: string): ChainRefusal | undefined => {
  if (profile.mainnet && optIn !== mainnetOptIn(profile)) return 'MainnetNotOptedIn'
  if (Option.isNone(profile.commercePayments)) return 'EscrowNotDeployed'
  return undefined
}

const tokenOf = (asset: AssetRef) => getAddress(asset.id.slice(asset.id.lastIndexOf(':') + 1))

/**
 * The settlement chain on `profile` with the deployment's operator, treasury and arbitrator, if the profile has
 * commerce-payments deployed. Callers check `chainRefusal` first.
 */
export const settlementChainOn = (
  profile: ChainProfile,
  deployment: ArcTestnetDeployment,
): Option.Option<SettlementChain> =>
  Option.map(profile.commercePayments, ({ escrow, collector }) => ({
    chainId: profile.chainId,
    asset: profile.asset,
    token: tokenOf(profile.asset),
    tokenDomain: profile.tokenDomain,
    escrow,
    collector,
    operator: getAddress(deployment.operator),
    feeBps: deployment.feeBps ?? 500,
    feeReceiver: getAddress(deployment.feeReceiver),
    arbitrator: getAddress(deployment.arbitrator),
    confirmations: deployment.confirmations ?? profile.confirmations,
  }))

/** The profile a chain name stands for; `arc-testnet` when unset. */
export const chainProfileOf = (name: Option.Option<string>): Option.Option<ChainProfile> =>
  Option.match(name, {
    onNone: () => Option.some(chainProfiles['arc-testnet']),
    onSome: (named) => Option.map(Schema.decodeUnknownOption(ChainName)(named), (known) => chainProfiles[known]),
  })
