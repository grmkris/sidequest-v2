import * as Domain from '@alchemy.run/domain'
import { AccountId } from '@sidequest/protocol'

/** The wallet is linked to an account already: `account`, which signing in with it reaches. */
export class WalletTaken extends Domain.Rejection('WalletTaken', { account: AccountId }) {}
