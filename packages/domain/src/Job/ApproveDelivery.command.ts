import * as Domain from '@alchemy.run/domain'
import { JobId, UnixSeconds } from '@sidequest/protocol'
import { personRejections } from '../Authority.ts'
import { NotPermitted } from '../NotPermitted.rejection.ts'
import { Session } from '../Session.middleware.ts'
import { WrongState } from './WrongState.rejection.ts'

export class DeliveryApproved extends Domain.Event('DeliveryApproved', { approvedAt: UnixSeconds }) {}

/** The buyer accepts the delivery, which releases payment, so only the person may. Approving again changes nothing. */
export class ApproveDelivery extends Domain.Command('ApproveDelivery', {
  target: JobId,
  middleware: [Session],
  events: [DeliveryApproved],
  rejects: [...personRejections, WrongState, NotPermitted],
}) {}
