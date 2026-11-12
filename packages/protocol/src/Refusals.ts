import { Schema } from 'effect'
import { NotSignedIn } from './SessionApi.ts'

/**
 * What a refusal shows: the fields of the rule that refused, such as the stage a job was in and the stages the
 * request needed. Values are plain JSON.
 */
export const Evidence = Schema.Record(Schema.String, Schema.Json)
export type Evidence = typeof Evidence.Type

// Each refusal names the rule that refused (`reason`, the domain's name for it) and its evidence. The HTTP status
// says what kind of refusal it is; the reason says which.

/** Who is asking may not do this: not the role it needs, an agent where a person must act, or an agent's grant. */
export const ForbiddenReason = Schema.Literals([
  'NotPermitted',
  'PersonRequired',
  'PartyRequired',
  'MissingScope',
  'AgentRevoked',
  'GrantExpired',
  'SelfBid',
  'AgentPaused',
])

export class Forbidden extends Schema.TaggedError<Forbidden>()(
  'Forbidden',
  { reason: ForbiddenReason, evidence: Evidence },
  { httpApiStatus: 403 },
) {}

/** What the request names does not exist (yet): an agent, a listing, a job, a bidder's proposal or a room. */
export const NotFoundReason = Schema.Literals([
  'NotRegistered',
  'ListingNotPublished',
  'NoProposal',
  'RoomNotOpen',
  'UnknownListing',
  'UnknownJob',
])

export class NotFound extends Schema.TaggedError<NotFound>()(
  'NotFound',
  { reason: NotFoundReason, evidence: Evidence },
  { httpApiStatus: 404 },
) {}

/**
 * The request does not fit the state it met: done already, the wrong stage, a superseded version or a digest that
 * does not match, too late, or a room that waits for a person.
 */
export const ConflictReason = Schema.Literals([
  'AlreadyRegistered',
  'AlreadyPublished',
  'ListingNotPublished',
  'WrongState',
  'StaleHead',
  'SupersededVersion',
  'DigestMismatch',
  'AlreadyReviewed',
  'AlreadyApproved',
  'DeliveryLate',
  'ReviewWindowClosed',
  'IdempotencyConflict',
  'AgentTurnLimit',
])

export class Conflict extends Schema.TaggedError<Conflict>()(
  'Conflict',
  { reason: ConflictReason, evidence: Evidence },
  { httpApiStatus: 409 },
) {}

/** The request is well formed but asks for something no state allows: an expiry that is not in the future. */
export const UnprocessableReason = Schema.Literals(['ExpiryNotInFuture'])

export class Unprocessable extends Schema.TaggedError<Unprocessable>()(
  'Unprocessable',
  { reason: UnprocessableReason, evidence: Evidence },
  { httpApiStatus: 422 },
) {}

/**
 * Every refusal the model can answer with, for the endpoints that send it a command or read it as the caller,
 * including finding no session where it needs one.
 */
export const refusals = [NotSignedIn, Forbidden, NotFound, Conflict, Unprocessable] as const

/** The cursor is not one this server gave out for this list. */
export class BadCursor extends Schema.TaggedError<BadCursor>()('BadCursor', {}, { httpApiStatus: 400 }) {}
