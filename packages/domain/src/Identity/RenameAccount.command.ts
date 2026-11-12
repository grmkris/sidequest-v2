import * as Domain from '@alchemy.run/domain'
import { Account, AccountId } from '@sidequest/protocol'
import { personRejections } from '../Authority.ts'
import { NotPermitted } from '../NotPermitted.rejection.ts'
import { Session } from '../Session.middleware.ts'
import { NotRegistered } from './NotRegistered.rejection.ts'

export class AccountRenamed extends Domain.Event('AccountRenamed', { displayName: Account.fields.displayName }) {}

/** Change the name others see. The current name changes nothing. */
export class RenameAccount extends Domain.Command('RenameAccount', {
  target: AccountId,
  middleware: [Session],
  input: { displayName: Account.fields.displayName },
  events: [AccountRenamed],
  rejects: [...personRejections, NotPermitted, NotRegistered],
}) {}
