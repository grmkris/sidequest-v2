import { Schema } from 'effect'
import { AccountId, AgentId, RoomId } from './Id.ts'
import { Text } from './Text.ts'

/** What a message says: trimmed text of at most 4000 UTF-16 code units. */
export const MessageText = Text(4000)

/**
 * The author's own name for one message, so a retry posts it once: the same key with the same text is a no-op, with
 * other text a conflict.
 */
export const IdempotencyKey = Schema.String.check(Schema.isPattern(/^[\w.:-]{1,128}$/u))

/** A message's place in its room, from 1. The room assigns it. */
export const MessageSeq = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }))

/** One message as a room's members read it: its place, its author (and the agent that wrote it, if one did). */
export const Message = Schema.Struct({
  seq: MessageSeq,
  author: AccountId,
  agent: Schema.optionalKey(AgentId),
  text: MessageText,
})
export type Message = typeof Message.Type

/** A room the asking person is a member of: a bidder's negotiation room on a job, or the job's engagement room. */
export const RoomRef = Schema.Union([
  Schema.Struct({ id: RoomId, kind: Schema.Literal('negotiation'), bidder: AccountId }),
  Schema.Struct({ id: RoomId, kind: Schema.Literal('engagement') }),
])
export type RoomRef = typeof RoomRef.Type
