import * as Domain from '@alchemy.run/domain'
import { AgentId } from '@sidequest/protocol'

/** The operator revoked this agent; it never acts again. */
export class AgentRevoked extends Domain.Rejection('AgentRevoked', { agent: AgentId }) {}
