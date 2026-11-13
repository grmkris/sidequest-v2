import { sha256 } from '@noble/hashes/sha2.js'
import { EventId, type UnsignedEvent } from './Event.ts'
import { hexOf } from './Hex.ts'

/**
 * The NIP-01 serialization `[0, pubkey, created_at, kind, tags, content]` as UTF-8 JSON with no whitespace.
 *
 * NIP-01 asks for the short escapes of `\n`, `"`, `\\`, `\r`, `\t`, `\b` and `\f` and no others; it is silent on the
 * other control characters, which `JSON.stringify` writes as `\u00XX`. That is what nostr-tools, rust-nostr and the
 * common relays do, so it is what this does.
 */
export const serializeEvent = (event: UnsignedEvent): string =>
  JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content])

/** The id an event must carry: the SHA-256 of its serialization. */
export const eventIdOf = (event: UnsignedEvent): EventId =>
  // SHA-256 is always 32 bytes, so its hex always matches the schema.
  EventId.make(hexOf(sha256(new TextEncoder().encode(serializeEvent(event)))))
