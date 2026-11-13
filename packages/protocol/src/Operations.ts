import { Schema } from 'effect'
import { Hex32 } from './Hex32.ts'
import { WalletAddress } from './Wallet.ts'

/**
 * The stage's relayer as anyone may read it (it pays every relayed call's gas): its address and balance in the
 * chain's native unit (wei, as a decimal string), whether that is below the stage's warning threshold, and, when the
 * stage caps daily gas, what the relayer committed since the UTC day began and the cap. `configured` is false on a
 * stage without settlement, where everything else is null. Nothing here is a secret: the chain shows all of it.
 */
export const SettlementHealth = Schema.Struct({
  configured: Schema.Boolean,
  chainId: Schema.NullOr(Schema.Int),
  mainnet: Schema.NullOr(Schema.Boolean),
  relayer: Schema.NullOr(WalletAddress),
  balance: Schema.NullOr(Schema.String),
  low: Schema.NullOr(Schema.Boolean),
  threshold: Schema.NullOr(Schema.String),
  gasCommittedToday: Schema.NullOr(Schema.String),
  dailyGasBudget: Schema.NullOr(Schema.String),
})
export type SettlementHealth = typeof SettlementHealth.Type

/** What the hide list holds: an event id, or a public key whose events it hides. */
export const HiddenKind = Schema.Literals(['event', 'pubkey'])

/** One entry of the index's hide list: what, why, when and by which moderator key. */
export const HiddenTarget = Schema.Struct({
  target: Hex32,
  kind: HiddenKind,
  reason: Schema.String,
  hiddenAt: Schema.Int,
  hiddenBy: Hex32,
})
export type HiddenTarget = typeof HiddenTarget.Type

/** Why an entry is hidden: a short note for the public list, such as a takedown notice's reference. */
export const HideRequest = Schema.Struct({
  kind: HiddenKind,
  reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
})

/** A moderation request's NIP-98 authorization is missing, does not verify for it, or is not the moderator key's. */
export class ModerationRefused extends Schema.TaggedError<ModerationRefused>()(
  'ModerationRefused',
  { reason: Schema.String },
  { httpApiStatus: 401 },
) {}

/** The header a read by id carries when the index's hide list covers what it answers (`hidden`). */
export const labelsHeader = 'sidequest-labels'
