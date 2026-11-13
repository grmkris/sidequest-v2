import { NostrEvent, serializeEvent, verifyEvent } from '@sidequest/nostr'
import {
  agentGrant,
  deliveryNote,
  grantRevocation,
  jobAccept,
  jobProposal,
  jobRequest,
  jobReview,
  type KindSpec,
  parseMessagingRelays,
  parseProfileName,
  parseRelayList,
  parseServiceListing,
  parseSidequestEvent,
  standardKinds,
  statement,
  type VocabularyRefused,
  walletLink,
} from '@sidequest/nostr/vocabulary'
import { Effect, Option, Result, Schema } from 'effect'
import { type Derived, messagingRelaysOf, profileOf, relayListOf } from './Derived.ts'

/** What an event passed beyond NIP-01's id and signature: the reader of its kind. */
export type Validation = 'profile' | 'relayList' | 'messagingRelays' | 'sidequest' | 'listing'

/** Why the index refuses an event. The vocabulary's reasons are those `@sidequest/nostr` gives for its kinds. */
export const RefusalReason = Schema.Literals([
  'malformed',
  'idMismatch',
  'badSignature',
  'tooLarge',
  'unknownKind',
  'badContent',
  'badEnvelope',
  'networkMismatch',
  'tagMismatch',
  'inconsistentContent',
])
export type RefusalReason = typeof RefusalReason.Type

/** The index refuses an event: it keeps only valid events of the kinds it cares about, and only so large. */
export class EventRefused extends Schema.TaggedError<EventRefused>()('EventRefused', {
  reason: RefusalReason,
  kind: Schema.optionalKey(Schema.Int),
}) {}

/** A valid event, what it passed, and what it derives (a profile or a relay list), if anything. */
export interface Validated {
  readonly event: NostrEvent
  readonly validation: Validation
  readonly derived: Option.Option<Derived>
}

/**
 * The most an event may hold. Content of 64 KiB is far beyond any Sidequest kind's schema (a request's description is
 * at most 5000 characters) and a large profile; 256 tags beyond any listing or relay list worth keeping. Lengths are
 * in UTF-16 code units, which bound UTF-8 bytes to three times as many.
 */
export const eventLimits = { contentLength: 65_536, tags: 256, serializedLength: 131_072 } as const

const refuse = (reason: RefusalReason, kind?: number) =>
  new EventRefused(kind === undefined ? { reason } : { reason, kind })

// `invalidEvent` and `wrongKind` are checked before a reader runs, so neither reaches here; they read as malformed.
const vocabularyReason = ({ reason }: VocabularyRefused): RefusalReason =>
  reason === 'invalidEvent' || reason === 'wrongKind' ? 'malformed' : reason

type Read = { readonly validation: Validation; readonly derived: Option.Option<Derived> }
type Reader = (event: NostrEvent) => Effect.Effect<Read, VocabularyRefused>

const nothingDerived = Option.none<Derived>()

const sidequest = <C>(spec: KindSpec<C>): readonly [number, Reader] => [
  spec.kind,
  (event) => parseSidequestEvent(spec, event).pipe(Effect.as({ validation: 'sidequest', derived: nothingDerived })),
]

/** A reader from one of `@sidequest/nostr`'s readers that answer a `Result`, with what its result derives. */
const deriving =
  <A>(
    validation: Validation,
    read: (input: unknown) => Result.Result<A, VocabularyRefused>,
    derive: (event: NostrEvent, read: A) => Derived,
  ): Reader =>
  (event) =>
    Effect.fromResult(read(event)).pipe(
      Effect.map((value) => ({ validation, derived: Option.some(derive(event, value)) })),
    )

/**
 * The kinds the index keeps, each with its reader: profiles, relay lists and messaging relay lists (NIP-01, NIP-65,
 * NIP-17), Sidequest listings (NIP-99) and Sidequest's own kinds. Every reader verifies the event again itself.
 */
const readers: ReadonlyMap<number, Reader> = new Map<number, Reader>([
  [standardKinds.profile, deriving('profile', parseProfileName, profileOf)],
  [standardKinds.relayList, deriving('relayList', parseRelayList, relayListOf)],
  [standardKinds.messagingRelays, deriving('messagingRelays', parseMessagingRelays, messagingRelaysOf)],
  [
    standardKinds.listing,
    (event) => parseServiceListing(event).pipe(Effect.as({ validation: 'listing', derived: nothingDerived })),
  ],
  sidequest(walletLink),
  sidequest(jobRequest),
  sidequest(jobProposal),
  sidequest(jobAccept),
  sidequest(deliveryNote),
  sidequest(statement),
  sidequest(jobReview),
  sidequest(agentGrant),
  sidequest(grantRevocation),
])

/** The kinds the index keeps, for relay filters. */
export const indexedKinds: ReadonlyArray<number> = [...readers.keys()].toSorted((a, b) => a - b)

const decodeShape = Schema.decodeUnknownResult(NostrEvent)

const tooLarge = (event: NostrEvent) =>
  event.content.length > eventLimits.contentLength ||
  event.tags.length > eventLimits.tags ||
  serializeEvent(event).length > eventLimits.serializedLength

/**
 * Whether the index keeps an event, and as what. In order: its shape, its size, its kind, its id and signature
 * (`verifyEvent`), then its kind's reader. Pure: the same input always gets the same answer, whenever it arrives.
 */
export const validateEvent = Effect.fnUntraced(function* (input: unknown): Effect.fn.Return<Validated, EventRefused> {
  const shaped = decodeShape(input)
  if (Result.isFailure(shaped)) return yield* refuse('malformed')
  const event = shaped.success
  if (tooLarge(event)) return yield* refuse('tooLarge', event.kind)
  const reader = readers.get(event.kind)
  if (reader === undefined) return yield* refuse('unknownKind', event.kind)
  const verified = verifyEvent(event)
  if (Result.isFailure(verified)) return yield* refuse(verified.failure.reason, event.kind)
  const read = yield* reader(event).pipe(Effect.mapError((error) => refuse(vocabularyReason(error), event.kind)))
  return { event, ...read }
})
