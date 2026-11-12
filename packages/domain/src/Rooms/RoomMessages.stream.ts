import * as Domain from '@alchemy.run/domain'
import { AccountId, AgentId } from '@sidequest/protocol'
import { Effect, Schema } from 'effect'
import { asViewer, viewerRejections } from '../Authority.ts'
import { NotPermitted } from '../NotPermitted.rejection.ts'
import { Session } from '../Session.middleware.ts'
import { Members, MessageSeq, MessageText } from './Message.ts'
import { Room } from './Room.aggregate.ts'

/** One message as members read it, with the room's members so each read can be judged on the latest entry. */
export class RoomMessage extends Domain.Event('RoomMessage', {
  seq: MessageSeq,
  author: AccountId,
  agent: Schema.optionalKey(AgentId),
  text: MessageText,
  members: Members,
}) {}

/** A room's messages in order, by sequence number, for its members and their agents. */
export class RoomMessages extends Domain.Stream('RoomMessages', {
  key: Room,
  entries: [RoomMessage],
  middleware: [Session],
  rejects: [...viewerRejections, NotPermitted],
  validate: Effect.fn(function* (_request, latest) {
    const account = yield* asViewer()
    // A room with no messages yet shows nothing to anyone.
    if (latest !== null && !latest.event.members.includes(account))
      return yield* new NotPermitted({ account, required: 'member' })
  }),
}) {}
