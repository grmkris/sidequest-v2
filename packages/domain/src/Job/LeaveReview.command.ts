import * as Domain from '@alchemy.run/domain'
import { AccountId, JobId, Review } from '@sidequest/protocol'
import { scopedRejections } from '../Authority.ts'
import { NotPermitted } from '../NotPermitted.rejection.ts'
import { Session } from '../Session.middleware.ts'
import { WrongState } from './WrongState.rejection.ts'

/** This side reviewed the job already. */
export class AlreadyReviewed extends Domain.Rejection('AlreadyReviewed', { author: AccountId }) {}

export class ReviewLeft extends Domain.Event('ReviewLeft', { review: Review }) {}

/** The buyer or the worker, or their agent with `discuss`, reviews the other side once the job is settled. */
export class LeaveReview extends Domain.Command('LeaveReview', {
  target: JobId,
  middleware: [Session],
  input: { rating: Review.fields.rating, comment: Review.fields.comment },
  events: [ReviewLeft],
  rejects: [...scopedRejections, WrongState, NotPermitted, AlreadyReviewed],
}) {}
