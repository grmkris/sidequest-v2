import * as Domain from '@alchemy.run/domain'
import { Schema } from 'effect'

/** The listing was never published, or its owner withdrew it. */
export class ListingNotPublished extends Domain.Rejection('ListingNotPublished', {
  state: Schema.Literals(['Unpublished', 'Withdrawn']),
}) {}
