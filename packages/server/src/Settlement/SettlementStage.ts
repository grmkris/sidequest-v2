import { Config, ConfigProvider, Effect, Option, Redacted, Schema } from 'effect'
import { arcTestnetRpcUrl } from '../SignIn/ArcRpc.ts'
import { malformedSettlementVariables, requiredSettlementVariables } from './EscrowConfig.ts'

/** The API Worker's settlement bindings for a stage: plain text, and secrets as `Redacted`, which bind as secrets. */
export type SettlementVariables = Readonly<Record<string, string | Redacted.Redacted>>

/** Settlement is half configured: the names that are missing or malformed (never their values). */
export class SettlementMisconfigured extends Schema.TaggedError<SettlementMisconfigured>()('SettlementMisconfigured', {
  names: Schema.Array(Schema.String),
}) {}

// Settlement's variables, read from the environment of the shell that deploys a stage (`alchemy.run.ts`). With all of
// them unset, settlement stays disabled exactly as before: the funding endpoints answer 503 and the saga reads nothing.
//
// Required together:
//   SIDEQUEST_OPERATOR_ADDRESS      the deployed `SidequestOperator`
//   SIDEQUEST_TREASURY_ADDRESS      the operator's immutable `FEE_RECEIVER`
//   SIDEQUEST_ARBITRATOR_ADDRESS    the interim arbitrator every job names (the address of SIDEQUEST_ARBITRATOR_KEY)
//   SIDEQUEST_RELAYER_KEY           secret: the key that relays operator calls and pays their gas (0x + 64 hex)
// Optional:
//   SIDEQUEST_ARBITRATOR_KEY        secret: the interim arbitrator's key; without it rulings answer 503
//   SIDEQUEST_ARBITRATION_OPERATOR  the account id allowed to issue rulings
//   SIDEQUEST_CONFIRMATIONS         blocks that make an event count (default 3)
//   SIDEQUEST_FEE_BPS               the operator's immutable `FEE_BPS` (default 500)
//   SIDEQUEST_ARBITRATION_PUBKEY    the Nostr key (64 hex) whose NIP-98 authorization asks for a Nostr-native ruling
//   SIDEQUEST_OPERATOR_DEPLOY_BLOCK the operator's deployment block, where the chain log poller first starts
//   SIDEQUEST_ARC_RPC_URL           the Arc testnet RPC endpoint (default the public one), read by `stageRpcUrl`
//
// The keys are read as `Config.Redacted` and bound as Worker secrets (`secret_text`), never as plain variables, so no
// plan, log or trace shows them. Nothing here reads or writes a key file.
const plainNames = [
  'SIDEQUEST_OPERATOR_ADDRESS',
  'SIDEQUEST_TREASURY_ADDRESS',
  'SIDEQUEST_ARBITRATOR_ADDRESS',
  'SIDEQUEST_ARBITRATION_OPERATOR',
  'SIDEQUEST_CONFIRMATIONS',
  'SIDEQUEST_FEE_BPS',
  'SIDEQUEST_ARBITRATION_PUBKEY',
  'SIDEQUEST_OPERATOR_DEPLOY_BLOCK',
] as const
const secretNames = ['SIDEQUEST_RELAYER_KEY', 'SIDEQUEST_ARBITRATOR_KEY'] as const

/**
 * Settlement's bindings from what is set: none, or a complete and well-formed set. A set the Worker would treat as
 * unconfigured, or would read only in part, is refused with the names at fault.
 */
export const settlementVariablesOf = (
  plain: Readonly<Record<string, string>>,
  secrets: Readonly<Record<string, Redacted.Redacted>>,
): Effect.Effect<SettlementVariables, SettlementMisconfigured> => {
  const revealed = Object.fromEntries(Object.entries(secrets).map(([name, value]) => [name, Redacted.value(value)]))
  const environment = { ...plain, ...revealed }
  if (Object.keys(environment).length === 0) return Effect.succeed({})
  const missing = requiredSettlementVariables.filter((name) => !(name in environment))
  const wrong = [...missing, ...malformedSettlementVariables(environment)]
  return wrong.length > 0
    ? Effect.fail(new SettlementMisconfigured({ names: wrong }))
    : Effect.succeed({ ...plain, ...secrets })
}

const setIn = <A>(value: Option.Option<A>, present: (found: A) => boolean) => Option.filter(value, present)

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
      ({ names }) =>
        new Config.ConfigError(
          new ConfigProvider.SourceError({
            message: `Sidequest.Settlement.halfConfigured: set or fix ${names.join(', ')}`,
          }),
        ),
    ),
  )
})

/** The Arc RPC endpoint for a stage: `SIDEQUEST_ARC_RPC_URL` from the deploying shell, or Arc testnet's public one. */
export const stageRpcUrl = Config.String('SIDEQUEST_ARC_RPC_URL').pipe(Config.withDefault(arcTestnetRpcUrl))
