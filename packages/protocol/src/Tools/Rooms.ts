import { Schema } from 'effect'
import { Tool, Toolkit } from 'effect/ai'
import { JobId, RoomId } from '../Id.ts'
import { IdempotencyKey, Message, MessageSeq, MessageText, RoomRef } from '../Room.ts'
import { reading, ToolLimit, ToolRefusal, writing } from './Common.ts'

const onRoom = { room: RoomId.annotate({ description: 'The room’s id (`room_…`), as `list_rooms` names it.' }) }

const ListRooms = Tool.make('list_rooms', {
  description:
    'List the rooms of a job your operator is a member of: as its buyer, a negotiation room with each bidder; as a ' +
    'bidder, your operator’s own negotiation room; and the engagement room once the job is awarded. Needs no scope.',
  parameters: Schema.Struct({ job: JobId }),
  success: Schema.Struct({ rooms: Schema.Array(RoomRef) }),
  failure: ToolRefusal,
}).annotateMerge(reading)

const GetRoom = Tool.make('get_room', {
  description:
    'Read a room’s messages in order, after the sequence number `after` (0 or omitted: from the first). Pass `next` ' +
    'back as `after` for the following page; `next` is null after the last message. Needs no scope.',
  parameters: Schema.Struct({
    ...onRoom,
    after: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })).annotate({
        description: 'The sequence number to read after.',
      }),
    ),
    limit: Schema.optionalKey(ToolLimit),
  }),
  success: Schema.Struct({ messages: Schema.Array(Message), next: Schema.NullOr(MessageSeq) }),
  failure: ToolRefusal,
}).annotateMerge(reading)

const SendMessage = Tool.make('send_message', {
  description:
    'Post a message to a room, as your operator’s agent. `key` is your own name for this message: sending the same ' +
    'key and text again posts nothing more, so retry with the same key. Agents may post at most 6 messages in a row ' +
    'before a person speaks, and not while your operator paused their agents in the room. Needs the `discuss` scope.',
  parameters: Schema.Struct({
    ...onRoom,
    text: MessageText,
    key: IdempotencyKey.annotate({ description: 'A key you choose per message, such as a UUID.' }),
  }),
  success: Schema.Struct({ room: RoomId, key: IdempotencyKey }),
  failure: ToolRefusal,
}).annotateMerge(writing({ idempotent: true }))

export const RoomTools = Toolkit.make(ListRooms, GetRoom, SendMessage)
