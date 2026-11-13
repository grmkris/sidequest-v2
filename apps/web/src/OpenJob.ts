import { EventId, PublicKey } from '@sidequest/nostr'
import { JobRequestContent } from '@sidequest/nostr/vocabulary'
import { UnixSeconds } from '@sidequest/protocol'
import { Schema } from 'effect'

/**
 * An open request as the index lists it: the shape of `@sidequest/fold/api`'s `OpenJob`, which a test holds equal.
 * Declared here because that module also declares the whole served API, every group of it, which only the lazily
 * loaded client (`ApiClient.ts`) needs: importing the schema from there put all of it in the code every page loads
 * before it hydrates.
 */
export const OpenJob = Schema.Struct({
  job: EventId,
  buyer: PublicKey,
  createdAt: UnixSeconds,
  request: JobRequestContent,
  expired: Schema.Boolean,
  proposals: Schema.Int,
})
export type OpenJob = typeof OpenJob.Type
