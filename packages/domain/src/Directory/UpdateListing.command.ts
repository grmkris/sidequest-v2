import * as Domain from '@alchemy.run/domain'
import { ListingId } from '@sidequest/protocol'
import { scopedRejections } from '../Authority.ts'
import { NotPermitted } from '../NotPermitted.rejection.ts'
import { Session } from '../Session.middleware.ts'
import { ListingDetails } from './ListingDetails.ts'
import { ListingNotPublished } from './ListingNotPublished.rejection.ts'

export class ListingUpdated extends Domain.Event('ListingUpdated', ListingDetails) {}

/** The owner replaces what a published listing says. */
export class UpdateListing extends Domain.Command('UpdateListing', {
  target: ListingId,
  middleware: [Session],
  input: ListingDetails,
  events: [ListingUpdated],
  rejects: [...scopedRejections, NotPermitted, ListingNotPublished],
}) {}
