import * as Domain from '@alchemy.run/domain'
import { UnixSeconds } from '@sidequest/protocol'

/** A requested expiry is not after the time the command arrived. */
export class ExpiryNotInFuture extends Domain.Rejection('ExpiryNotInFuture', {
  expiresAt: UnixSeconds,
  now: UnixSeconds,
}) {}
