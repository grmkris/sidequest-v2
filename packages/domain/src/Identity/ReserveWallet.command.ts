import * as Domain from '@alchemy.run/domain'
import { AccountId, AccountRef, UnixSeconds } from '@sidequest/protocol'
import { Session } from '../Session.middleware.ts'
import { SystemOnly } from '../SystemOnly.rejection.ts'
import { WalletTaken } from './WalletTaken.rejection.ts'

export class WalletReserved extends Domain.Event('WalletReserved', { account: AccountId, until: UnixSeconds }) {}

/** Another account's reservation of the wallet holds until `until`; a sign-in in flight finishes it. */
export class ReservationHeld extends Domain.Rejection('ReservationHeld', {
  account: AccountId,
  until: UnixSeconds,
}) {}

/**
 * Hold the wallet for an account being registered with it, for a few minutes. Sign-in sends it after the wallet's
 * signature was verified, before it registers the account; a reservation that lapsed may be taken by another.
 */
export class ReserveWallet extends Domain.Command('ReserveWallet', {
  target: AccountRef,
  middleware: [Session],
  input: { account: AccountId },
  events: [WalletReserved],
  rejects: [SystemOnly, WalletTaken, ReservationHeld],
}) {}
