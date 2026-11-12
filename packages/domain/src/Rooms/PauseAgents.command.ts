import * as Domain from '@alchemy.run/domain'
import { AccountId, RoomId } from '@sidequest/protocol'
import { personRejections } from '../Authority.ts'
import { NotPermitted } from '../NotPermitted.rejection.ts'
import { Session } from '../Session.middleware.ts'
import { RoomNotOpen } from './RoomNotOpen.rejection.ts'

export class AgentsPaused extends Domain.Event('AgentsPaused', { member: AccountId }) {}

/** A member stops their own agents from posting in this room until they resume them. */
export class PauseAgents extends Domain.Command('PauseAgents', {
  target: RoomId,
  middleware: [Session],
  events: [AgentsPaused],
  rejects: [...personRejections, RoomNotOpen, NotPermitted],
}) {}
