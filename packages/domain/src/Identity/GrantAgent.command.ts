import * as Domain from '@alchemy.run/domain'
import { AgentId, Grant } from '@sidequest/protocol'
import { AgentRevoked } from '../AgentRevoked.rejection.ts'
import { personRejections } from '../Authority.ts'
import { ExpiryNotInFuture } from '../ExpiryNotInFuture.rejection.ts'
import { NotPermitted } from '../NotPermitted.rejection.ts'
import { Session } from '../Session.middleware.ts'
import { NotRegistered } from './NotRegistered.rejection.ts'

export class AgentGranted extends Domain.Event('AgentGranted', { grant: Grant }) {}

/** The operator gives the agent scopes until an expiry, replacing any earlier grant. */
export class GrantAgent extends Domain.Command('GrantAgent', {
  target: AgentId,
  middleware: [Session],
  input: { grant: Grant },
  events: [AgentGranted],
  rejects: [...personRejections, NotRegistered, NotPermitted, AgentRevoked, ExpiryNotInFuture],
}) {}
