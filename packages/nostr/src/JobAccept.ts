import { Digest } from '@sidequest/protocol'
import { Schema } from 'effect'
import { EventId } from './Event.ts'
import { PublicKey } from './PublicKey.ts'
import type { KindSpec } from './KindSpec.ts'
import { sidequestKinds } from './Kinds.ts'
import { eventTag, personTag } from './RoutingTags.ts'

/**
 * The buyer accepts one proposal (kind 8413), binding its exact terms by digest. It moves money, so its author names
 * the network in `sq-net`; whoever indexes it checks that against the proposal's terms.
 */
export const JobAcceptContent = Schema.Struct({
  job: EventId,
  proposal: EventId,
  termsDigest: Digest,
  worker: PublicKey,
})
export type JobAcceptContent = typeof JobAcceptContent.Type

export const jobAccept: KindSpec<JobAcceptContent> = {
  kind: sidequestKinds.accept,
  content: JobAcceptContent,
  routing: (content) => [eventTag(content.job), eventTag(content.proposal), personTag(content.worker)],
  network: 'required',
}
