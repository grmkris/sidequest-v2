import * as Domain from '@alchemy.run/domain'
import { Digest, JobId, UnixSeconds } from '@sidequest/protocol'
import { Session } from '../Session.middleware.ts'
import { SystemOnly } from '../SystemOnly.rejection.ts'
import { WrongState } from './WrongState.rejection.ts'

export class DeliveryRecorded extends Domain.Event('DeliveryRecorded', {
  artifactHash: Digest,
  deliveredAt: UnixSeconds,
  reviewEndsAt: UnixSeconds,
}) {}

/**
 * The settlement saga reports the delivery hash posted on chain and the block time it was posted at. The review
 * window runs from that chain time.
 */
export class RecordDelivery extends Domain.Command('RecordDelivery', {
  target: JobId,
  middleware: [Session],
  input: { artifactHash: Digest, deliveredAt: UnixSeconds },
  events: [DeliveryRecorded],
  rejects: [SystemOnly, WrongState],
}) {}
