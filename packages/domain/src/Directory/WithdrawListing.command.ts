import * as Domain from '@alchemy.run/domain'
import { ListingId } from '@sidequest/protocol'
import { scopedRejections } from '../Authority.ts'
import { NotPermitted } from '../NotPermitted.rejection.ts'
import { Session } from '../Session.middleware.ts'
import { ListingNotPublished } from './ListingNotPublished.rejection.ts'

export class ListingWithdrawn extends Domain.Event('ListingWithdrawn') {}

/** The owner takes a listing down for good. Withdrawing a withdrawn listing changes nothing. */
export class WithdrawListing extends Domain.Command('WithdrawListing', {
  target: ListingId,
  middleware: [Session],
  events: [ListingWithdrawn],
  rejects: [...scopedRejections, NotPermitted, ListingNotPublished],
}) {}
