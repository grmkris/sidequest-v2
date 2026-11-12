import * as Domain from '@alchemy.run/domain'
import { Effect } from 'effect'
import { MessagePosted } from './PostMessage.command.ts'
import { Room } from './Room.aggregate.ts'
import { RoomMessage, RoomMessages } from './RoomMessages.stream.ts'

/** Appends each posted message to its room's {@link RoomMessages} stream; the stream drops a redelivered append. */
export class RoomMessageLog extends Domain.Projection('RoomMessageLog', {
  from: [Room],
  key: Room,
  on: [MessagePosted],
  writes: [RoomMessages],
}) {}

export const RoomMessageLogLive = RoomMessageLog.toLayer(
  Effect.gen(function* () {
    const messages = yield* RoomMessages
    return (batch) =>
      Effect.forEach(
        batch,
        (input) => {
          const { seq, author, agent, text, members } = input.event
          const message = { seq, author, text, members }
          return messages.append(input, new RoomMessage(agent === undefined ? message : { ...message, agent }))
        },
        { discard: true },
      )
  }),
)
