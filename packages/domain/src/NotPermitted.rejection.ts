import * as Domain from '@alchemy.run/domain'
import { AccountId } from '@sidequest/protocol'
import { Schema } from 'effect'

/**
 * The role a command or read needs: `holder` of an account, `party` (the buyer or the worker) to a job, `bidder` on
 * it, or `member` of a room.
 */
export const Role = Schema.Literals(['holder', 'operator', 'owner', 'buyer', 'worker', 'party', 'bidder', 'member'])

/** The acting account does not hold the role this command needs. */
export class NotPermitted extends Domain.Rejection('NotPermitted', { account: AccountId, required: Role }) {}
