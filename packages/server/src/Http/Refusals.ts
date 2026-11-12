import type { AgentRevoked } from '@sidequest/domain/AgentRevoked.rejection'
import type { ListingNotPublished } from '@sidequest/domain/Directory/ListingNotPublished.rejection'
import type { AlreadyPublished } from '@sidequest/domain/Directory/PublishListing.command'
import type { ExpiryNotInFuture } from '@sidequest/domain/ExpiryNotInFuture.rejection'
import type { GrantExpired } from '@sidequest/domain/GrantExpired.rejection'
import type { AlreadyRegistered } from '@sidequest/domain/Identity/AlreadyRegistered.rejection'
import type { NotRegistered } from '@sidequest/domain/Identity/NotRegistered.rejection'
import type { DigestMismatch } from '@sidequest/domain/Job/DigestMismatch.rejection'
import type { AlreadyReviewed } from '@sidequest/domain/Job/LeaveReview.command'
import type { NoProposal } from '@sidequest/domain/Job/NoProposal.rejection'
import type { DeliveryLate } from '@sidequest/domain/Job/SubmitDelivery.command'
import type { SelfBid, StaleHead } from '@sidequest/domain/Job/SubmitProposal.command'
import type { SupersededVersion } from '@sidequest/domain/Job/SupersededVersion.rejection'
import type { WrongState } from '@sidequest/domain/Job/WrongState.rejection'
import type { MissingScope } from '@sidequest/domain/MissingScope.rejection'
import type { NotPermitted } from '@sidequest/domain/NotPermitted.rejection'
import type { PartyRequired } from '@sidequest/domain/PartyRequired.rejection'
import type { PersonRequired } from '@sidequest/domain/PersonRequired.rejection'
import type { AgentPaused, AgentTurnLimit, IdempotencyConflict } from '@sidequest/domain/Rooms/PostMessage.command'
import type { RoomNotOpen } from '@sidequest/domain/Rooms/RoomNotOpen.rejection'
import type { Unauthorized } from '@sidequest/domain/Session.middleware'
import {
  Conflict,
  type ConflictReason,
  Evidence,
  Forbidden,
  type ForbiddenReason,
  NotFound,
  type NotFoundReason,
  NotSignedIn,
  Unprocessable,
  type UnprocessableReason,
} from '@sidequest/protocol'
import { Effect, Match, Schema } from 'effect'
import type { RpcClientError } from 'effect/rpc/RpcClientError'

/** Every way the model refuses what the HTTP API sends it, and the session middleware finding no one. */
export type Refusal = (
  | typeof NotPermitted
  | typeof PersonRequired
  | typeof PartyRequired
  | typeof MissingScope
  | typeof AgentRevoked
  | typeof GrantExpired
  | typeof SelfBid
  | typeof AgentPaused
  | typeof NotRegistered
  | typeof ListingNotPublished
  | typeof NoProposal
  | typeof RoomNotOpen
  | typeof AlreadyRegistered
  | typeof AlreadyPublished
  | typeof WrongState
  | typeof StaleHead
  | typeof SupersededVersion
  | typeof DigestMismatch
  | typeof AlreadyReviewed
  | typeof DeliveryLate
  | typeof IdempotencyConflict
  | typeof AgentTurnLimit
  | typeof ExpiryNotInFuture
  | typeof Unauthorized
)['Type']

/** What a call into the model through the in-process Api can fail with. */
export type ModelError = Refusal | RpcClientError

/** The refusals of the model whose name the protocol lists under `reason`. */
type Named<Reasons extends Schema.Top> = Extract<Refusal, { readonly _tag: Reasons['Type'] }>

const isEvidence = Schema.is(Evidence)

/** A rejection's fields, which are plain JSON: ids, numbers, stages, versions and digests. */
const evidenceOf = (fields: object): Evidence => (isEvidence(fields) ? fields : {})

const forbidden = ({ _tag: reason, ...fields }: Named<typeof ForbiddenReason>) =>
  new Forbidden({ reason, evidence: evidenceOf(fields) })
const notFound = ({ _tag: reason, ...fields }: Named<typeof NotFoundReason>) =>
  new NotFound({ reason, evidence: evidenceOf(fields) })
const conflict = ({ _tag: reason, ...fields }: Named<typeof ConflictReason>) =>
  new Conflict({ reason, evidence: evidenceOf(fields) })
const unprocessable = ({ _tag: reason, ...fields }: Named<typeof UnprocessableReason>) =>
  new Unprocessable({ reason, evidence: evidenceOf(fields) })

/**
 * The HTTP error for each refusal: 403 when who is asking may not, 404 when what it names does not exist, 409 when
 * the state does not allow it (now), 422 for an expiry that is not in the future, 401 for no session. Every refusal
 * has a case: one the model adds and this map lacks does not compile, and neither does a case that files a refusal
 * under a status whose reasons the protocol does not list it in.
 */
const apiErrorOf = (refusal: Refusal) =>
  Match.valueTags(refusal, {
    NotPermitted: forbidden,
    PersonRequired: forbidden,
    PartyRequired: forbidden,
    MissingScope: forbidden,
    AgentRevoked: forbidden,
    GrantExpired: forbidden,
    SelfBid: forbidden,
    AgentPaused: forbidden,
    NotRegistered: notFound,
    NoProposal: notFound,
    RoomNotOpen: notFound,
    // Never published is nothing to find; withdrawn is a listing that may no longer change.
    ListingNotPublished: (withheld) => (withheld.state === 'Unpublished' ? notFound(withheld) : conflict(withheld)),
    AlreadyRegistered: conflict,
    AlreadyPublished: conflict,
    WrongState: conflict,
    StaleHead: conflict,
    SupersededVersion: conflict,
    DigestMismatch: conflict,
    AlreadyReviewed: conflict,
    DeliveryLate: conflict,
    IdempotencyConflict: conflict,
    AgentTurnLimit: conflict,
    ExpiryNotInFuture: unprocessable,
    Unauthorized: () => new NotSignedIn(),
  })

/**
 * Answers a call into the model with the API's errors. Its error channel may hold only {@link Refusal}s, so a call
 * that can fail with a rejection this module does not map does not compile. The in-process transport failing is a
 * defect.
 */
export const refused = <A, R>(call: Effect.Effect<A, ModelError, R>) =>
  call.pipe(
    Effect.catchTag('RpcClientError', (error) => Effect.die(error)),
    Effect.mapError(apiErrorOf),
  )
