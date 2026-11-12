import { Schema } from 'effect'
import { Digest } from './Digest.ts'
import { JobId } from './Id.ts'

/** The worker's artifact: its SHA-256, which goes on chain, and where to fetch it. */
export const Delivery = Schema.Struct({
  job: JobId,
  artifactHash: Digest,
  url: Schema.String.check(Schema.isPattern(/^https:\/\/[^\s]+$/u), Schema.isMaxLength(2048)),
})
export type Delivery = typeof Delivery.Type
