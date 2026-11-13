import { mainnetOptIn } from '@sidequest/settlement/Chains'
import { Config, ConfigProvider, Effect, Option, Predicate, Redacted, Schema } from 'effect'
import { arcTestnetRpcUrl } from './ArcRpc.ts'
import {
  chainProfileFrom,
  malformedSettlementVariables,
  requiredSettlementVariables,
  settlementChainRefusal,
} from './SettlementConfig.ts'

/** The API Worker's settlement bindings for a stage: plain text, and secrets as `Redacted`, which bind as secrets. */
export type SettlementVariables = Readonly<Record<string, string | Redacted.Redacted>>

/** Settlement is half configured: the names that are missing or malformed (never their values). */
export class SettlementMisconfigured extends Schema.TaggedError<SettlementMisconfigured>()('SettlementMisconfigured', {
  names: Schema.Array(Schema.String),
}) {}

/**
 * The stage names a chain it may not settle on: a mainnet without `SIDEQUEST_ALLOW_MAINNET` set to exactly that
 * chain's phrase (`MainnetNotOptedIn`), or a chain where the escrow is not deployed (`EscrowNotDeployed`).
 */
export class SettlementChainRefused extends Schema.TaggedError<SettlementChainRefused>()('SettlementChainRefused', {
  chain: Schema.String,
  reason: Schema.Literals(['MainnetNotOptedIn', 'EscrowNotDeployed']),
  optIn: Schema.String,
}) {}

// Settlement's variables, read from the environment of the shell that deploys a stage (`alchemy.run.ts`). With all of
// them unset, settlement stays disabled: the escrow endpoints answer 503, and the settler and the chain log poller do
// nothing.
//
// Required together:
//   SIDEQUEST_OPERATOR_ADDRESS      the deployed `SidequestOperator`
//   SIDEQUEST_TREASURY_ADDRESS      the operator's immutable `FEE_RECEIVER`
//   SIDEQUEST_ARBITRATOR_ADDRESS    the interim arbitrator every job names (the address of SIDEQUEST_ARBITRATOR_KEY)
//   SIDEQUEST_RELAYER_KEY           secret: the key that relays operator calls and pays their gas (0x + 64 hex)
// Optional:
//   SIDEQUEST_ARBITRATOR_KEY        secret: the interim arbitrator's key; without it rulings answer 503
//   SIDEQUEST_CONFIRMATIONS         blocks that make an event count (default 3)
//   SIDEQUEST_FEE_BPS               the operator's immutable `FEE_BPS` (default 500)
//   SIDEQUEST_ARBITRATION_PUBKEY    the Nostr key (64 hex) whose NIP-98 authorization asks for a ruling
//   SIDEQUEST_OPERATOR_DEPLOY_BLOCK the operator's deployment block, where the chain log poller first starts
//   SIDEQUEST_ARC_RPC_URL           the chain's RPC endpoint (default the chain's public one), read by `stageRpcUrl`
//   SIDEQUEST_CHAIN                 the chain (`@sidequest/settlement/Chains`): `arc-testnet` (default), or a mainnet,
//                                   `arc-mainnet` or `base-mainnet`, which are refused unless...
//   SIDEQUEST_ALLOW_MAINNET         ...this is exactly `settle real money on <chain> (chain <id>)`; the Worker checks
//                                   it again, so a stage needs both the chain and the phrase to move real money
//   SIDEQUEST_RELAYER_LOW_BALANCE_WEI the relayer balance below which the stage warns (default the chain's)
//   SIDEQUEST_CAP_MAX_JOB_AMOUNT    launch cap: the most one job may escrow, in the asset's atomic units
//   SIDEQUEST_CAP_ALLOWED_PUBKEYS   launch cap: comma-separated Nostr keys (64 hex); only jobs whose buyer and bidder
//                                   are both listed are funded through this stage
//   SIDEQUEST_CAP_DAILY_GAS_WEI     launch cap: the most gas, in wei, relayed requests may commit per UTC day
//
// The keys are read as `Config.Redacted` and bound as Worker secrets (`secret_text`), never as plain variables, so no
// plan, log or trace shows them. Nothing here reads or writes a key file.
const plainNames = [
  'SIDEQUEST_OPERATOR_ADDRESS',
  'SIDEQUEST_TREASURY_ADDRESS',
  'SIDEQUEST_ARBITRATOR_ADDRESS',
  'SIDEQUEST_CONFIRMATIONS',
  'SIDEQUEST_FEE_BPS',
  'SIDEQUEST_ARBITRATION_PUBKEY',
  'SIDEQUEST_OPERATOR_DEPLOY_BLOCK',
  'SIDEQUEST_CHAIN',
  'SIDEQUEST_ALLOW_MAINNET',
  'SIDEQUEST_RELAYER_LOW_BALANCE_WEI',
  'SIDEQUEST_CAP_MAX_JOB_AMOUNT',
  'SIDEQUEST_CAP_ALLOWED_PUBKEYS',
  'SIDEQUEST_CAP_DAILY_GAS_WEI',
] as const
const secretNames = ['SIDEQUEST_RELAYER_KEY', 'SIDEQUEST_ARBITRATOR_KEY'] as const

/**
 * Settlement's bindings from what is set: none, or a complete and well-formed set. A set the Worker would treat as
 * unconfigured, or would read only in part, is refused with the names at fault.
 */
export const settlementVariablesOf = (
  plain: Readonly<Record<string, string>>,
  secrets: Readonly<Record<string, Redacted.Redacted>>,
): Effect.Effect<SettlementVariables, SettlementMisconfigured | SettlementChainRefused> => {
  const revealed = Object.fromEntries(Object.entries(secrets).map(([name, value]) => [name, Redacted.value(value)]))
  const environment = { ...plain, ...revealed }
  if (Object.keys(environment).length === 0) return Effect.succeed({})
  const missing = requiredSettlementVariables.filter((name) => !(name in environment))
  const wrong = [...missing, ...malformedSettlementVariables(environment)]
  if (wrong.length > 0) return Effect.fail(new SettlementMisconfigured({ names: wrong }))
  const refusal = settlementChainRefusal(environment)
  const profile = Option.getOrUndefined(chainProfileFrom(environment))
  return refusal === undefined || profile === undefined
    ? Effect.succeed({ ...plain, ...secrets })
    : Effect.fail(new SettlementChainRefused({ chain: profile.name, reason: refusal, optIn: mainnetOptIn(profile) }))
}

const setIn = <A>(value: Option.Option<A>, present: (found: A) => boolean) => Option.filter(value, present)

/** What a refused deploy says: the names to set or fix, or why the chain is refused; never a value. */
const deployRefusal = (failure: SettlementMisconfigured | SettlementChainRefused) =>
  Predicate.isTagged(failure, 'SettlementMisconfigured')
    ? `Sidequest.Settlement.halfConfigured: set or fix ${failure.names.join(', ')}`
    : failure.reason === 'EscrowNotDeployed'
      ? `Sidequest.Settlement.chainRefused: the escrow is not deployed on ${failure.chain}`
      : `Sidequest.Settlement.chainRefused: ${failure.chain} moves real money; to settle there set ` +
        `SIDEQUEST_ALLOW_MAINNET to exactly "${failure.optIn}"`

/** Settlement's variables from the deploying shell's environment (see above); fails the deploy if half configured. */
export const settlementVariablesFromShell = Effect.gen(function* () {
  const plain: Record<string, string> = {}
  for (const name of plainNames) {
    const value = setIn(yield* Config.option(Config.String(name)), (found) => found.length > 0)
    if (Option.isSome(value)) plain[name] = value.value
  }
  const secrets: Record<string, Redacted.Redacted> = {}
  for (const name of secretNames) {
    const value = setIn(yield* Config.option(Config.Redacted(name)), (found) => Redacted.value(found).length > 0)
    if (Option.isSome(value)) secrets[name] = value.value
  }
  // A deploy fails only on configuration: say which names to set or fix, never their values.
  return yield* settlementVariablesOf(plain, secrets).pipe(
    Effect.mapError(
      (failure) =>
        new Config.ConfigError(
          new ConfigProvider.SourceError({
            message: deployRefusal(failure),
          }),
        ),
    ),
  )
})

/**
 * The RPC endpoint for a stage: `SIDEQUEST_ARC_RPC_URL` from the deploying shell, or the public one of the chain
 * `SIDEQUEST_CHAIN` names (Arc testnet's when unset or unknown; settlement refuses an unknown chain on its own).
 */
export const stageRpcUrl = Effect.gen(function* () {
  const chain = yield* Config.option(Config.String('SIDEQUEST_CHAIN'))
  const profile = chainProfileFrom(Option.isSome(chain) ? { SIDEQUEST_CHAIN: chain.value } : {})
  const fallback = Option.match(profile, { onNone: () => arcTestnetRpcUrl, onSome: (found) => found.publicRpcUrl })
  return yield* Config.String('SIDEQUEST_ARC_RPC_URL').pipe(Config.withDefault(fallback))
})
