import * as Domain from '@alchemy.run/domain'
import { Account, AccountId, AccountRef } from '@sidequest/protocol'
import { personRejections } from '../Authority.ts'
import { NotPermitted } from '../NotPermitted.rejection.ts'
import { Session } from '../Session.middleware.ts'
import { AlreadyRegistered } from './AlreadyRegistered.rejection.ts'

export class AccountRegistered extends Domain.Event('AccountRegistered', {
  displayName: Account.fields.displayName,
  wallet: AccountRef,
}) {}

/** Create the account a person signed in as, with the wallet they signed in with. */
export class RegisterAccount extends Domain.Command('RegisterAccount', {
  target: AccountId,
  middleware: [Session],
  input: { displayName: Account.fields.displayName, wallet: AccountRef },
  events: [AccountRegistered],
  rejects: [...personRejections, NotPermitted, AlreadyRegistered],
}) {}
