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
