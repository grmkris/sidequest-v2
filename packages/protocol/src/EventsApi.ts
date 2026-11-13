import { Schema } from 'effect'
import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api'
import { Unavailable } from './SessionApi.ts'

/**
 * A signed Nostr event as JSON (NIP-01), in the shape a client sends and the index serves. The shape only: the server
 * recomputes the id and checks the signature, and reads Sidequest's kinds with `@sidequest/nostr`.
 */
export const SignedEvent = Schema.Struct({
  id: Schema.String,
  pubkey: Schema.String,
  created_at: Schema.Int,
  kind: Schema.Int,
  tags: Schema.Array(Schema.Array(Schema.String)),
  content: Schema.String,
  sig: Schema.String,
})
export type SignedEvent = typeof SignedEvent.Type

/** 32 bytes as 64 lowercase hex characters: an event id or an x-only public key. */
const Hex32 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))

/** What publishing did: stored the event, or found it stored already. */
export const Published = Schema.Struct({ id: Hex32, status: Schema.Literals(['stored', 'duplicate']) })
export type Published = typeof Published.Type

/**
 * Why an event is not valid: not an event's shape, an id that is not its hash, a signature that fails, or (for
 * Sidequest's kinds and listings) content, envelope, network or tags the vocabulary refuses.
 */
export const EventInvalidReason = Schema.Literals([
  'malformed',
  'idMismatch',
  'badSignature',
  'badContent',
  'badEnvelope',
  'networkMismatch',
  'tagMismatch',
  'inconsistentContent',
])

export class EventInvalid extends Schema.TaggedError<EventInvalid>()(
  'EventInvalid',
  { reason: EventInvalidReason },
  { httpApiStatus: 400 },
) {}

/** The index keeps profiles, relay lists, listings and Sidequest's kinds; this event is of another kind. */
export class KindNotIndexed extends Schema.TaggedError<KindNotIndexed>()(
  'KindNotIndexed',
  { kind: Schema.Int },
  { httpApiStatus: 422 },
) {}

/** The event's content, tags or whole serialization is larger than the index keeps. */
export class EventTooLarge extends Schema.TaggedError<EventTooLarge>()('EventTooLarge', {}, { httpApiStatus: 413 }) {}

/** This client or this key published too much lately; it may try again after `retryAfterSeconds`. */
export class RateLimited extends Schema.TaggedError<RateLimited>()(
  'RateLimited',
  { retryAfterSeconds: Schema.Int },
  { httpApiStatus: 429 },
) {}

/** The index has no such event, or knows nothing of that key. */
export class NotIndexed extends Schema.TaggedError<NotIndexed>()('NotIndexed', {}, { httpApiStatus: 404 }) {}

/** Where a person's latest list came from: its event and when they signed it. */
const Origin = { event: Hex32, createdAt: Schema.Int }

/**
 * What the index knows of a key: its latest profile (kind 0), its latest relay list (NIP-65, kind 10002) and its
 * latest messaging relays (NIP-17, kind 10050), each `null` until one is seen. "Latest" is the greatest `created_at`,
 * ties to the lowest event id, whatever order the events arrived in.
 */
export const Person = Schema.Struct({
  pubkey: Hex32,
  profile: Schema.NullOr(
    Schema.Struct({
      name: Schema.NullOr(Schema.String),
      about: Schema.NullOr(Schema.String),
      picture: Schema.NullOr(Schema.String),
      ...Origin,
    }),
  ),
  relays: Schema.NullOr(
    Schema.Struct({ read: Schema.Array(Schema.String), write: Schema.Array(Schema.String), ...Origin }),
  ),
  messagingRelays: Schema.NullOr(Schema.Struct({ relays: Schema.Array(Schema.String), ...Origin })),
})
export type Person = typeof Person.Type

/**
 * The index over signed Nostr events. Anyone publishes one signed event through it (the event authenticates itself,
 * so there is no session) and the index stores it and relays it on; anyone reads a stored event, and what the index
 * knows of a key. Publishing is limited per client and per key.
 */
export class EventsApi extends HttpApiGroup.make('events').add(
  HttpApiEndpoint.post('publish', '/api/events', {
    payload: SignedEvent,
    success: Published,
    error: [EventInvalid, KindNotIndexed, EventTooLarge, RateLimited, Unavailable],
  }),
  HttpApiEndpoint.get('event', '/api/events/:id', {
    params: { id: Hex32 },
    success: SignedEvent,
    error: [NotIndexed, Unavailable],
  }),
  HttpApiEndpoint.get('person', '/api/people/:pubkey', {
    params: { pubkey: Hex32 },
    success: Person,
    error: [NotIndexed, Unavailable],
  }),
) {}
