import { Bytes32, Text, textDigest } from '@sidequest/protocol'
import { Effect, Schema } from 'effect'
import { EventId } from './Event.ts'
import { PublicKey } from './PublicKey.ts'
import type { KindSpec } from './KindSpec.ts'
import { sidequestKinds } from './Kinds.ts'
import { eventTag, personTag } from './RoutingTags.ts'

const HttpsUrl = Schema.String.check(Schema.isPattern(/^https:\/\/\S{1,2000}$/u))

/**
 * The worker says what they delivered (kind 8414): the `deliveryHash` they also submit to the escrow, and where to
 * find it. It concerns money on a network, which its author names in `sq-net`.
 */
export const DeliveryNoteContent = Schema.Struct({
  job: EventId,
  buyer: PublicKey,
  deliveryHash: Bytes32,
  url: Schema.optionalKey(HttpsUrl),
  note: Schema.optionalKey(Text(4000)),
})
export type DeliveryNoteContent = typeof DeliveryNoteContent.Type

export const deliveryNote: KindSpec<DeliveryNoteContent> = {
  kind: sidequestKinds.deliveryNote,
  content: DeliveryNoteContent,
  routing: (content) => [eventTag(content.job), personTag(content.buyer)],
  network: 'required',
}

/** Where the delivered work is, as a delivery note states it: the job, and its address or a note, or both. */
export type Delivered = Pick<DeliveryNoteContent, 'job' | 'url' | 'note'>

/**
 * The `deliveryHash` a delivery note carries and the worker signs onto the escrow: `0x` and the SHA-256 of the RFC 8785
 * canonical JSON of `{ job, note?, url? }`, the note's own statement of what was delivered. Every member is a string
 * and the keys are written in their sorted order, so `JSON.stringify` writes exactly the canonical form. Anyone holding
 * the note recomputes it, and the fold's `matchesChain` compares it with the hash the chain recorded.
 */
export const deliveryHashOf = (delivered: Delivered): Effect.Effect<Bytes32> =>
  textDigest(
    JSON.stringify({
      job: delivered.job,
      ...(delivered.note === undefined ? {} : { note: delivered.note }),
      ...(delivered.url === undefined ? {} : { url: delivered.url }),
    }),
  ).pipe(Effect.map((digest): Bytes32 => `0x${digest}`))
