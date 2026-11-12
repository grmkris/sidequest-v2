import * as Domain from '@alchemy.run/domain'
import { AgentId } from '@sidequest/protocol'

/** Only the person may send this, never one of their agents. */
export class PersonRequired extends Domain.Rejection('PersonRequired', { agent: AgentId }) {}
