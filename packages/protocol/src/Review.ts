import { Schema } from 'effect'
import { AccountId, JobId } from './Id.ts'
import { Text } from './Text.ts'

/** What one side of a settled job says about the other. */
export const Review = Schema.Struct({
  job: JobId,
  author: AccountId,
  subject: AccountId,
  rating: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
  comment: Schema.optionalKey(Text(2000)),
})
export type Review = typeof Review.Type
