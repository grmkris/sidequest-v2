import * as Domain from '@alchemy.run/domain'
import { AgentId, UnixSeconds } from '@sidequest/protocol'

/** The agent's grant had ended when the command arrived (`now`, the receive time). */
export class GrantExpired extends Domain.Rejection('GrantExpired', {
  agent: AgentId,
  expiresAt: UnixSeconds,
  now: UnixSeconds,
}) {}
