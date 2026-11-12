import * as Domain from '@alchemy.run/domain'
import { AccountId, JobId, RoomId, roomIdOf, RoomKind } from '@sidequest/protocol'
import { Session } from '../Session.middleware.ts'
import { SystemOnly } from '../SystemOnly.rejection.ts'
import { Members } from './Message.ts'

const OpenRoomInput = { job: JobId, kind: RoomKind, buyer: AccountId, counterpart: AccountId }

/** The room an {@link OpenRoom} names: the job's engagement room, or the counterpart's negotiation room on it. */
export const roomIdFor = ({ job, kind, counterpart }: { job: JobId; kind: RoomKind; counterpart: AccountId }) =>
  roomIdOf(kind === 'engagement' ? { job, kind } : { job, kind, bidder: counterpart })

/** The room addressed is not the one its job, kind and counterpart name. */
export class WrongRoom extends Domain.Rejection('WrongRoom', { expected: RoomId }) {}

export class RoomOpened extends Domain.Event('RoomOpened', { job: JobId, kind: RoomKind, members: Members }) {}

/**
 * The system opens a job's room for the buyer and a counterpart: a bidder for a negotiation, the worker for an
 * engagement. Opening an open room changes nothing, so a redelivered policy opens it once.
 */
export class OpenRoom extends Domain.Command('OpenRoom', {
  target: RoomId,
  middleware: [Session],
  input: OpenRoomInput,
  events: [RoomOpened],
  rejects: [SystemOnly, WrongRoom],
}) {}
