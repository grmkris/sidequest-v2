import * as Domain from '@alchemy.run/domain'
import { ListingDetails, ListingId } from '@sidequest/protocol'
import { scopedRejections } from '../Authority.ts'
import { NotPermitted } from '../NotPermitted.rejection.ts'
import { Session } from '../Session.middleware.ts'
import { ListingNotPublished } from './ListingNotPublished.rejection.ts'

export class ListingUpdated extends Domain.Event('ListingUpdated', ListingDetails.fields) {}

/** The owner replaces what a published listing says. */
export class UpdateListing extends Domain.Command('UpdateListing', {
  target: ListingId,
  middleware: [Session],
  input: ListingDetails.fields,
  events: [ListingUpdated],
  rejects: [...scopedRejections, NotPermitted, ListingNotPublished],
}) {}
