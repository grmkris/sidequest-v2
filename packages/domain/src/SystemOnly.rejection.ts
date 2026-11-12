import * as Domain from '@alchemy.run/domain'
import { AccountId } from '@sidequest/protocol'

/** Only the system (the settlement saga or a policy) may send this; a person or agent may not. */
export class SystemOnly extends Domain.Rejection('SystemOnly', { account: AccountId }) {}
