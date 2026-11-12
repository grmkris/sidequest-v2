import { Schema } from 'effect'
import { AccountId, JobId } from './Id.ts'
import { Text } from './Text.ts'
import { UnixSeconds } from './UnixSeconds.ts'

/** What a buyer asks for. Its id is the job's id. */
export const WorkRequest = Schema.Struct({
  id: JobId,
  buyer: AccountId,
  title: Text(200),
  description: Text(5000),
  expiresAt: UnixSeconds,
})
export type WorkRequest = typeof WorkRequest.Type

/** An open request as the list of open requests shows it. */
export const OpenRequest = Schema.Struct({
  id: WorkRequest.fields.id,
  buyer: WorkRequest.fields.buyer,
  title: WorkRequest.fields.title,
  expiresAt: WorkRequest.fields.expiresAt,
})
export type OpenRequest = typeof OpenRequest.Type
