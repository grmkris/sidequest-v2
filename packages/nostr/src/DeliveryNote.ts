import { Bytes32, Text } from '@sidequest/protocol'
import { Schema } from 'effect'
import { EventId } from './Event.ts'
import { PublicKey } from './Keys.ts'
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
