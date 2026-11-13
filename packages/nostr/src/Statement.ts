import { Text } from '@sidequest/protocol'
import { Schema } from 'effect'
import { EventId } from './Event.ts'
import type { KindSpec } from './KindSpec.ts'
import { sidequestKinds } from './Kinds.ts'
import { eventTag, optionalTag } from './RoutingTags.ts'

/** What a statement is for: asking to withdraw a request or a proposal, or giving a reason for a rejection. */
export const StatementType = Schema.Literals(['withdraw_request', 'withdraw_proposal', 'rejection_reason'])
export type StatementType = typeof StatementType.Type

/** A party says something on the record about a job (kind 8415), optionally about one event of it. */
export const StatementContent = Schema.Struct({
  job: EventId,
  about: Schema.optionalKey(EventId),
  type: StatementType,
  text: Text(4000),
})
export type StatementContent = typeof StatementContent.Type

export const statement: KindSpec<StatementContent> = {
  kind: sidequestKinds.statement,
  content: StatementContent,
  routing: (content) => [eventTag(content.job), ...optionalTag(content.about, eventTag)],
  network: 'none',
}
