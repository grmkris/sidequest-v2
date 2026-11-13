import { Context, Effect, Option, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'
import { stored } from '@sidequest/serving/Stored'
import { type Hex, isHex, parseTransaction } from 'viem'

/**
 * A stage's launch caps, for the first weeks with real money: the most one job may escrow (in the asset's atomic
 * units), the keys whose jobs this stage funds at all (both the buyer and the bidder must be listed), and the most gas
 * relayed requests may commit per UTC day (in wei). Each is off when unset, as on the preview. They bound what this
 * stage relays and pays gas for, nothing more: anyone may still call the contract directly.
 */
export interface LaunchCaps {
  readonly maxJobAmount: Option.Option<bigint>
  readonly allowedPubkeys: Option.Option<ReadonlySet<string>>
  readonly dailyGasWei: Option.Option<bigint>
}

/** Which cap a request ran into. */
export type LaunchCapBreach = 'MaxJobAmount' | 'PartyNotAllowed' | 'DailyGasBudget'

export const noLaunchCaps: LaunchCaps = {
  maxJobAmount: Option.none(),
  allowedPubkeys: Option.none(),
  dailyGasWei: Option.none(),
}

/** The stage's launch caps; none unless the Worker's variables set them. */
export const LaunchCapSettings = Context.Reference<LaunchCaps>('Sidequest/Escrow/LaunchCaps', {
  defaultValue: () => noLaunchCaps,
})

type Environment = Readonly<Record<string, unknown>>

const Amount = Schema.String.check(Schema.isPattern(/^\d{1,30}$/u))
const amountOf = (environment: Environment, name: string) =>
  Option.map(Schema.decodeUnknownOption(Amount)(environment[name]), BigInt)

const Pubkeys = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}(\s*,\s*[0-9a-f]{64})*$/u))

/**
 * The caps from a Worker's variables (`SIDEQUEST_CAP_MAX_JOB_AMOUNT`, `SIDEQUEST_CAP_ALLOWED_PUBKEYS`,
 * `SIDEQUEST_CAP_DAILY_GAS_WEI`; see `Settlement/SettlementStage.ts`). A malformed one reads as unset; the deploy
 * refused it already.
 */
export const launchCapsFrom = (environment: Environment): LaunchCaps => ({
  maxJobAmount: amountOf(environment, 'SIDEQUEST_CAP_MAX_JOB_AMOUNT'),
  allowedPubkeys: Option.map(
    Schema.decodeUnknownOption(Pubkeys)(environment['SIDEQUEST_CAP_ALLOWED_PUBKEYS']),
    (list) => new Set(list.split(',').map((key) => key.trim())),
  ),
  dailyGasWei: amountOf(environment, 'SIDEQUEST_CAP_DAILY_GAS_WEI'),
})

/**
 * The cap funding a job would break, if any: its amount above the most a job may escrow, or a buyer or bidder not on
 * the stage's list. `bidder` is the proposal's principal (its author, or the operator whose agent made it).
 */
export const fundingCapBreach = (
  caps: LaunchCaps,
  funding: { readonly amount: string; readonly buyer: string; readonly bidder: string },
): LaunchCapBreach | undefined => {
  if (Option.isSome(caps.maxJobAmount) && BigInt(funding.amount) > caps.maxJobAmount.value) return 'MaxJobAmount'
  if (
    Option.isSome(caps.allowedPubkeys) &&
    !(caps.allowedPubkeys.value.has(funding.buyer) && caps.allowedPubkeys.value.has(funding.bidder))
  )
    return 'PartyNotAllowed'
  return undefined
}

/** The start of the UTC day `millis` falls in, in milliseconds. */
export const utcDayStart = (millis: number) => millis - (millis % 86_400_000)

const hexOf = (value: string): Hex => (isHex(value) ? value : '0x')

/** The most a signed transaction can cost its sender in gas: its gas limit times its highest fee per gas. */
const committedBy = (raw: string) => {
  const parsed = Option.liftThrowable(parseTransaction)(hexOf(raw))
  return Option.match(parsed, {
    onNone: () => 0n,
    onSome: ({ gas, maxFeePerGas, gasPrice }) => (gas ?? 0n) * (maxFeePerGas ?? gasPrice ?? 0n),
  })
}

/**
 * The gas `signer` committed since `sinceMillis`: for every transaction the relayer signed from then on (calls,
 * replacements and releases, mined or not), its gas limit times its highest fee. An upper bound of what was spent:
 * what counts against a budget is what the relayer made itself liable for.
 */
export const gasCommitted = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const read = SqlSchema.findAll({
    Request: Schema.Struct({ signer: Schema.String, since: Schema.Number }),
    Result: Schema.Struct({ raw: Schema.String }),
    execute: ({ signer, since }) => sql`
      SELECT t.raw FROM relayer_transactions AS t JOIN relayer_intents AS i ON i.id = t.intent
      WHERE t.signed_at >= ${since} AND i.signer = ${signer}`,
  })
  return (signer: string, sinceMillis: number) =>
    Effect.map(stored(read({ signer, since: sinceMillis })), (rows) =>
      rows.reduce((total, { raw }) => total + committedBy(raw), 0n),
    )
})
