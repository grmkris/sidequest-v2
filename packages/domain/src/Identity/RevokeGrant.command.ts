import * as Domain from '@alchemy.run/domain'
import { AgentId } from '@sidequest/protocol'
import { personRejections } from '../Authority.ts'
import { NotPermitted } from '../NotPermitted.rejection.ts'
import { Session } from '../Session.middleware.ts'
import { NotRegistered } from './NotRegistered.rejection.ts'

export class GrantRevoked extends Domain.Event('GrantRevoked') {}

/** The operator revokes the agent for good. Revoking a revoked agent changes nothing. */
export class RevokeGrant extends Domain.Command('RevokeGrant', {
  target: AgentId,
  middleware: [Session],
  events: [GrantRevoked],
  rejects: [...personRejections, NotRegistered, NotPermitted],
}) {}
