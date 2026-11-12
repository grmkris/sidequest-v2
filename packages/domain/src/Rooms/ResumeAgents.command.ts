import * as Domain from '@alchemy.run/domain'
import { AccountId, RoomId } from '@sidequest/protocol'
import { personRejections } from '../Authority.ts'
import { NotPermitted } from '../NotPermitted.rejection.ts'
import { Session } from '../Session.middleware.ts'
import { RoomNotOpen } from './RoomNotOpen.rejection.ts'

export class AgentsResumed extends Domain.Event('AgentsResumed', { member: AccountId }) {}

/** A member lets their own agents post in this room again. */
export class ResumeAgents extends Domain.Command('ResumeAgents', {
  target: RoomId,
  middleware: [Session],
  events: [AgentsResumed],
  rejects: [...personRejections, RoomNotOpen, NotPermitted],
}) {}
