import { UnixSeconds } from '@sidequest/protocol'
import { Schema } from 'effect'
import { lowerHex } from './Hex.ts'
import { PublicKey } from './PublicKey.ts'

/** An event's id: the SHA-256 of its NIP-01 serialization, as 64 lowercase hex characters. */
export const EventId = lowerHex(32).pipe(Schema.brand('EventId'))
export type EventId = typeof EventId.Type

/** A BIP-340 Schnorr signature of an event id, as 128 lowercase hex characters. */
export const Signature = lowerHex(64).pipe(Schema.brand('Signature'))
export type Signature = typeof Signature.Type

/** NIP-01 kinds are integers from 0 to 65535. */
export const Kind = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65_535 }))

/** One tag: its name, then its values. */
export const Tag = Schema.Array(Schema.String)
export type Tag = typeof Tag.Type

/** What an author decides before signing: everything but the id, the key and the signature. */
export const EventTemplate = Schema.Struct({
  created_at: UnixSeconds,
  kind: Kind,
  tags: Schema.Array(Tag),
  content: Schema.String,
})
export type EventTemplate = typeof EventTemplate.Type

/** A template with its author: what the id commits to (and, unsigned, a NIP-59 rumor). */
export const UnsignedEvent = Schema.Struct({ pubkey: PublicKey, ...EventTemplate.fields })
export type UnsignedEvent = typeof UnsignedEvent.Type

/**
 * A template as `pubkey`'s unsigned event. Copies exactly the template's fields, so a signed event passed as a
 * template never carries its old id, key or signature into the new one.
 */
export const authored = (pubkey: PublicKey, template: EventTemplate): UnsignedEvent => ({
  pubkey,
  created_at: template.created_at,
  kind: template.kind,
  tags: template.tags,
  content: template.content,
})

/** A NIP-01 event. Decoding checks only its shape; `verifyEvent` checks its id and signature. */
export const NostrEvent = Schema.Struct({ id: EventId, ...UnsignedEvent.fields, sig: Signature })
export type NostrEvent = typeof NostrEvent.Type
