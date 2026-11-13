import { Schema } from 'effect'
import { EventId, type EventTemplate, UnsignedEvent } from './Event.ts'
import { eventIdOf } from './EventHash.ts'
import type { PublicKey } from './Keys.ts'

/**
 * A NIP-59 rumor: an event with its id but deliberately no signature, so a leaked one proves nothing. Only a seal
 * signed by its author vouches for it, and only to the seal's recipient.
 */
export const Rumor = Schema.Struct({ id: EventId, ...UnsignedEvent.fields })
export type Rumor = typeof Rumor.Type

/** The rumor `author` would say, with its id computed. */
export const makeRumor = (template: EventTemplate, author: PublicKey): Rumor => {
  const unsigned = { pubkey: author, ...template }
  return { id: eventIdOf(unsigned), ...unsigned }
}
