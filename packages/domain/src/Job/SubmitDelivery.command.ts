import * as Domain from '@alchemy.run/domain'
import { Delivery, JobId, UnixSeconds } from '@sidequest/protocol'
import { scopedRejections } from '../Authority.ts'
import { NotPermitted } from '../NotPermitted.rejection.ts'
import { Session } from '../Session.middleware.ts'
import { WrongState } from './WrongState.rejection.ts'

/** The command arrived (`now`) after the agreed delivery deadline. */
export class DeliveryLate extends Domain.Rejection('DeliveryLate', { deadline: UnixSeconds, now: UnixSeconds }) {}

export class DeliverySubmitted extends Domain.Event('DeliverySubmitted', { delivery: Delivery }) {}

/** The worker, or their agent with `deliver`, hands over the artifact's hash and URL before the deadline. */
export class SubmitDelivery extends Domain.Command('SubmitDelivery', {
  target: JobId,
  middleware: [Session],
  input: { artifactHash: Delivery.fields.artifactHash, url: Delivery.fields.url },
  events: [DeliverySubmitted],
  rejects: [...scopedRejections, WrongState, NotPermitted, DeliveryLate],
}) {}
