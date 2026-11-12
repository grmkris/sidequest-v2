import { Schema } from 'effect'
import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api'
import { SignedIn } from './Guards.ts'
import { JobId, RoomId } from './Id.ts'
import { PageSize } from './Page.ts'
import { refusals } from './Refusals.ts'
import { IdempotencyKey, Message, MessageSeq, MessageText, RoomRef } from './Room.ts'

const onRoom = { room: RoomId }

/** A message's sequence number in the query string. */
const SeqFromString = Schema.FiniteFromString.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
)

/**
 * The rooms of a job the signed-in person is a member of, and in each: read the messages after a sequence number,
 * post one under an idempotency key, and see whether your own agents are paused, and pause or resume them.
 */
export class RoomsApi extends HttpApiGroup.make('rooms')
  .add(
    HttpApiEndpoint.get('list', '/api/jobs/:job/rooms', {
      params: { job: JobId },
      success: Schema.Struct({ rooms: Schema.Array(RoomRef) }),
      error: refusals,
    }),
    HttpApiEndpoint.get('messages', '/api/rooms/:room/messages', {
      params: onRoom,
      query: { after: Schema.optional(SeqFromString), limit: Schema.optional(PageSize) },
      // `next` is the sequence number to read after for the next page, `null` after the last message.
      success: Schema.Struct({ messages: Schema.Array(Message), next: Schema.NullOr(MessageSeq) }),
      error: refusals,
    }),
    HttpApiEndpoint.post('post', '/api/rooms/:room/messages', {
      params: onRoom,
      payload: Schema.Struct({ text: MessageText, key: IdempotencyKey }),
      error: refusals,
    }),
    HttpApiEndpoint.get('agents', '/api/rooms/:room/agents', {
      params: onRoom,
      success: Schema.Struct({ paused: Schema.Boolean }),
      error: refusals,
    }),
    HttpApiEndpoint.post('pause', '/api/rooms/:room/pause', { params: onRoom, error: refusals }),
    HttpApiEndpoint.post('resume', '/api/rooms/:room/resume', { params: onRoom, error: refusals }),
  )
  .middleware(SignedIn) {}
