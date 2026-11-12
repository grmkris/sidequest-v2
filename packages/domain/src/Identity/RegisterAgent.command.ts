import * as Domain from '@alchemy.run/domain'
import { AccountId, Agent, AgentId } from '@sidequest/protocol'
import { personRejections } from '../Authority.ts'
import { Session } from '../Session.middleware.ts'
import { AlreadyRegistered } from './AlreadyRegistered.rejection.ts'

export class AgentRegistered extends Domain.Event('AgentRegistered', {
  operator: AccountId,
  name: Agent.fields.name,
}) {}

/** A person registers an agent they operate. It may do nothing until they grant it scopes. */
export class RegisterAgent extends Domain.Command('RegisterAgent', {
  target: AgentId,
  middleware: [Session],
  input: { name: Agent.fields.name },
  events: [AgentRegistered],
  rejects: [...personRejections, AlreadyRegistered],
}) {}
