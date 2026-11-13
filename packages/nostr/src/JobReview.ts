import { Text } from '@sidequest/protocol'
import { Schema } from 'effect'
import { EventId } from './Event.ts'
import { PublicKey } from './PublicKey.ts'
import type { KindSpec } from './KindSpec.ts'
import { sidequestKinds } from './Kinds.ts'
import { eventTag, personTag } from './RoutingTags.ts'

/** One side of a job rates the other (kind 8416), from 1 to 5. */
export const JobReviewContent = Schema.Struct({
  job: EventId,
  subject: PublicKey,
  rating: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
  text: Text(2000),
})
export type JobReviewContent = typeof JobReviewContent.Type

export const jobReview: KindSpec<JobReviewContent> = {
  kind: sidequestKinds.review,
  content: JobReviewContent,
  routing: (content) => [eventTag(content.job), personTag(content.subject)],
  network: 'none',
}
