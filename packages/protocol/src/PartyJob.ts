import { Schema } from 'effect'
import { JobState } from './JobState.ts'
import { WorkRequest } from './WorkRequest.ts'

/** How an account takes part in a job: it posted the request, it bid on it, or it won it. */
export const JobRole = Schema.Literals(['buyer', 'bidder', 'worker'])
export type JobRole = typeof JobRole.Type

/** A job one account takes part in, as the list of its jobs shows it: the request, its stage and the account's role. */
export const PartyJob = Schema.Struct({
  id: WorkRequest.fields.id,
  buyer: WorkRequest.fields.buyer,
  title: WorkRequest.fields.title,
  expiresAt: WorkRequest.fields.expiresAt,
  state: JobState,
  role: JobRole,
})
export type PartyJob = typeof PartyJob.Type
