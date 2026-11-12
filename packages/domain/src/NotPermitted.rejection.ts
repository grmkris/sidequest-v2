import * as Domain from '@alchemy.run/domain'
import { AccountId } from '@sidequest/protocol'
import { Schema } from 'effect'

/** The role a command needs: `holder` of an account, or `party` (the buyer or the worker) to a job. */
export const Role = Schema.Literals(['holder', 'operator', 'owner', 'buyer', 'worker', 'party'])

/** The acting account does not hold the role this command needs. */
export class NotPermitted extends Domain.Rejection('NotPermitted', { account: AccountId, required: Role }) {}
