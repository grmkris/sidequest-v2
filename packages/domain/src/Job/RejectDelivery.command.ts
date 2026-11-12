import * as Domain from '@alchemy.run/domain'
import { DisputeReason, JobId, UnixSeconds } from '@sidequest/protocol'
import { personRejections } from '../Authority.ts'
import { NotPermitted } from '../NotPermitted.rejection.ts'
import { Session } from '../Session.middleware.ts'
import { WrongState } from './WrongState.rejection.ts'

/** The buyer approved this delivery already. */
export class AlreadyApproved extends Domain.Rejection('AlreadyApproved', { approvedAt: UnixSeconds }) {}

/** The review window, which runs from the chain-observed delivery, had closed when the command arrived. */
export class ReviewWindowClosed extends Domain.Rejection('ReviewWindowClosed', {
  endsAt: UnixSeconds,
  now: UnixSeconds,
}) {}

export class DeliveryRejected extends Domain.Event('DeliveryRejected', { reason: DisputeReason }) {}

/** The buyer disputes the delivery within the review window. An arbitrator then rules. */
export class RejectDelivery extends Domain.Command('RejectDelivery', {
  target: JobId,
  middleware: [Session],
  input: { reason: DisputeReason },
  events: [DeliveryRejected],
  rejects: [...personRejections, WrongState, NotPermitted, AlreadyApproved, ReviewWindowClosed],
}) {}
