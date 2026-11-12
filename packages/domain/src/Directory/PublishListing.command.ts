import * as Domain from '@alchemy.run/domain'
import { AccountId, ListingDetails, ListingId } from '@sidequest/protocol'
import { scopedRejections } from '../Authority.ts'
import { Session } from '../Session.middleware.ts'

export class AlreadyPublished extends Domain.Rejection('AlreadyPublished', { owner: AccountId }) {}

export class ListingPublished extends Domain.Event('ListingPublished', {
  owner: AccountId,
  ...ListingDetails.fields,
}) {}

/** A seller, or their agent with `propose`, offers what they do. The acting account owns the listing. */
export class PublishListing extends Domain.Command('PublishListing', {
  target: ListingId,
  middleware: [Session],
  input: ListingDetails.fields,
  events: [ListingPublished],
  rejects: [...scopedRejections, AlreadyPublished],
}) {}
