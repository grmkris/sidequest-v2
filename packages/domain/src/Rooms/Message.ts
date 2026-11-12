import { AccountId } from '@sidequest/protocol'
import { Schema } from 'effect'

/** A count from zero. */
export const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))

/** A room's two members: the buyer, then the bidder (negotiation) or the worker (engagement). */
export const Members = Schema.Tuple([AccountId, AccountId])
export type Members = typeof Members.Type

/** At most this many messages in a row may come from agents; then a person must post. */
export const agentTurnLimit = 6

/**
 * How many of the latest messages' idempotency keys (`IdempotencyKey`) a room remembers. Older keys can be used again.
 */
export const rememberedKeys = 32
