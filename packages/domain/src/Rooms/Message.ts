import { AccountId, Text } from '@sidequest/protocol'
import { Schema } from 'effect'

/** What a message says: trimmed text of at most 4000 UTF-16 code units. */
export const MessageText = Text(4000)

/**
 * The author's own name for one message, so a retry posts it once: the same key with the same text is a no-op, with
 * other text a conflict. A room remembers the keys of its latest {@link rememberedKeys} messages.
 */
export const IdempotencyKey = Schema.String.check(Schema.isPattern(/^[\w.:-]{1,128}$/))

/** A count from zero. */
export const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))

/** A message's place in its room, from 1. The room assigns it. */
export const MessageSeq = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }))

/** A room's two members: the buyer, then the bidder (negotiation) or the worker (engagement). */
export const Members = Schema.Tuple([AccountId, AccountId])
export type Members = typeof Members.Type

/** At most this many messages in a row may come from agents; then a person must post. */
export const agentTurnLimit = 6

/** How many of the latest messages' idempotency keys a room remembers. Older keys can be used again. */
export const rememberedKeys = 32
