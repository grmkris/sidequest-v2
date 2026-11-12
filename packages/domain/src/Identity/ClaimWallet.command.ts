import * as Domain from '@alchemy.run/domain'
import { AccountId, AccountRef } from '@sidequest/protocol'
import { Session } from '../Session.middleware.ts'
import { SystemOnly } from '../SystemOnly.rejection.ts'
import { WalletTaken } from './WalletTaken.rejection.ts'

export class WalletClaimed extends Domain.Event('WalletClaimed', { account: AccountId }) {}

/** The account holds no reservation of the wallet: it never reserved it, or another took it after it lapsed. */
export class NotReserved extends Domain.Rejection('NotReserved', { account: AccountId }) {}

/**
 * Commit the account's reservation: the wallet is the account's for good. Sign-in sends it once the account is
 * registered with the wallet. Claiming a wallet the account holds changes nothing.
 */
export class ClaimWallet extends Domain.Command('ClaimWallet', {
  target: AccountRef,
  middleware: [Session],
  input: { account: AccountId },
  events: [WalletClaimed],
  rejects: [SystemOnly, WalletTaken, NotReserved],
}) {}
