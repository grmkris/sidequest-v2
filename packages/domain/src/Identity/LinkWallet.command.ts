import * as Domain from '@alchemy.run/domain'
import { AccountId, AccountRef } from '@sidequest/protocol'
import { personRejections } from '../Authority.ts'
import { NotPermitted } from '../NotPermitted.rejection.ts'
import { Session } from '../Session.middleware.ts'
import { NotRegistered } from './NotRegistered.rejection.ts'

export class WalletLinked extends Domain.Event('WalletLinked', { wallet: AccountRef }) {}

/** Add a wallet the account holder proved they control. Linking a linked wallet changes nothing. */
export class LinkWallet extends Domain.Command('LinkWallet', {
  target: AccountId,
  middleware: [Session],
  input: { wallet: AccountRef },
  events: [WalletLinked],
  rejects: [...personRejections, NotPermitted, NotRegistered],
}) {}
