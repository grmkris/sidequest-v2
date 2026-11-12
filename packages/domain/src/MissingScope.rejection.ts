import * as Domain from '@alchemy.run/domain'
import { AgentId, GrantScope } from '@sidequest/protocol'

/** The agent's grant does not include the scope this command needs. */
export class MissingScope extends Domain.Rejection('MissingScope', { agent: AgentId, scope: GrantScope }) {}
