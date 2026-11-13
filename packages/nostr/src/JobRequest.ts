import { Text, UnixSeconds } from '@sidequest/protocol'
import { Schema } from 'effect'
import { PublicKey } from './PublicKey.ts'
import type { KindSpec } from './KindSpec.ts'
import { sidequestKinds } from './Kinds.ts'
import { ListingAddress } from './ListingAddress.ts'
import { optionalTag, personTag } from './RoutingTags.ts'

/** A topic, as NIP-12 `t` tags carry them: lowercase so `#t` filters match. */
const Topic = Text(40).check(Schema.isLowercased())

/**
 * A buyer asks for work (kind 8411). The request event's id is the job's id, on relays and in the escrow contract.
 * Optional fields route it: `topics` to `#t`, `listing` (a NIP-99 listing it answers) to `#a`, `to` (a seller it is
 * addressed to) to `#p`. `expiresAt` is also its NIP-40 `expiration`, so relays may drop it after.
 */
export const JobRequestContent = Schema.Struct({
  title: Text(200),
  description: Text(5000),
  expiresAt: UnixSeconds,
  topics: Schema.optionalKey(Schema.Array(Topic).check(Schema.isMaxLength(10), Schema.isUnique())),
  listing: Schema.optionalKey(ListingAddress),
  to: Schema.optionalKey(PublicKey),
})
export type JobRequestContent = typeof JobRequestContent.Type

export const jobRequest: KindSpec<JobRequestContent> = {
  kind: sidequestKinds.request,
  content: JobRequestContent,
  routing: (content) => [
    ['expiration', String(content.expiresAt)],
    ...(content.topics ?? []).map((topic) => ['t', topic]),
    ...optionalTag(content.listing, (listing) => ['a', listing]),
    ...optionalTag(content.to, personTag),
  ],
  network: 'none',
}
