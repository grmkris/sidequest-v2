import * as Domain from '@alchemy.run/domain'
import { DisputeReason, JobId } from '@sidequest/protocol'
import { personRejections } from '../Authority.ts'
import { NotPermitted } from '../NotPermitted.rejection.ts'
import { Session } from '../Session.middleware.ts'
import { WrongState } from './WrongState.rejection.ts'

export class DeliveryRejected extends Domain.Event('DeliveryRejected', { reason: DisputeReason }) {}

/**
 * The buyer says why they rejected the delivery, for the arbitrator. The rejection itself is the buyer's signature,
 * which the server relays to the chain first: the chain judges the review window, and the job becomes `Disputed` only
 * when the settlement saga records what the chain did. So this records the reason and changes no stage. The first
 * reason stands; stating one again records nothing.
 */
export class RejectDelivery extends Domain.Command('RejectDelivery', {
  target: JobId,
  middleware: [Session],
  input: { reason: DisputeReason },
  events: [DeliveryRejected],
  rejects: [...personRejections, WrongState, NotPermitted],
}) {}
