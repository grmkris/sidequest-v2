import { Schema } from 'effect'
import { JobId, RoomId } from './Id.ts'
import { UnixSeconds } from './UnixSeconds.ts'

/** What happened that concerns the account. */
export const InboxKind = Schema.Literals([
  'proposal_submitted',
  'change_requested',
  'proposal_accepted',
  'funding_recorded',
  'delivery_recorded',
  'job_settled',
  'message_posted',
])
export type InboxKind = typeof InboxKind.Type

/** One thing in a person's inbox: what happened, on which job (and in which room), and when. */
export const InboxEntry = Schema.Struct({
  id: Schema.String,
  kind: InboxKind,
  job: JobId,
  room: Schema.NullOr(RoomId),
  at: UnixSeconds,
})
export type InboxEntry = typeof InboxEntry.Type
