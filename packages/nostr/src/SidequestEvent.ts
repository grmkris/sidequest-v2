import type { NetworkRef, UnixSeconds } from '@sidequest/protocol'
import { Effect, Option, Predicate, Schema } from 'effect'
import type { EventId, EventTemplate, NostrEvent, Tag } from './Event.ts'
import { type Envelope, envelopeTags, impliedTagsMatch, readEnvelope } from './Envelope.ts'
import type { KindSpec } from './KindSpec.ts'
import { verifyEvent } from './Verify.ts'

/** Why an event is not a valid Sidequest event of the kind asked for, or why one could not be built. */
export class VocabularyRefused extends Schema.TaggedError<VocabularyRefused>()('VocabularyRefused', {
  reason: Schema.Literals([
    'invalidEvent',
    'wrongKind',
    'badContent',
    'badEnvelope',
    'networkMismatch',
    'tagMismatch',
    'inconsistentContent',
  ]),
}) {}

/** When the event is made, the network it binds money on (for kinds that need one), and the grant an agent uses. */
export interface BuildOptions {
  readonly createdAt: UnixSeconds
  readonly network?: NetworkRef
  readonly grant?: EventId
}

/** A verified Sidequest event with its decoded content and envelope. */
export interface ParsedEvent<C> {
  readonly event: NostrEvent
  readonly content: C
  readonly envelope: Envelope
}

const refused = (reason: VocabularyRefused['reason']) => new VocabularyRefused({ reason })

/** The network an event of this kind must name, given what its author named; `None` when that is not allowed. */
const settledNetwork = <C>(
  spec: KindSpec<C>,
  content: C,
  named: Option.Option<NetworkRef>,
): Option.Option<Option.Option<NetworkRef>> => {
  const rule = spec.network
  if (Predicate.isFunction(rule)) {
    const derived = rule(content)
    return Option.getOrElse(
      Option.map(named, (network) => network === derived),
      () => true,
    )
      ? Option.some(Option.some(derived))
      : Option.none()
  }
  return Option.isSome(named) === (rule === 'required') ? Option.some(named) : Option.none()
}

/** Every tag an event of this kind with this content and envelope must carry, and no others. */
const expectedTags = <C>(spec: KindSpec<C>, content: C, envelope: Envelope): ReadonlyArray<Tag> => [
  ...spec.routing(content),
  ...envelopeTags(envelope),
]

const checkContent = <C>(spec: KindSpec<C>, content: C) =>
  (spec.check?.(content) ?? Effect.succeed(true)).pipe(
    Effect.flatMap((consistent) => (consistent ? Effect.void : Effect.fail(refused('inconsistentContent')))),
  )

/**
 * The unsigned event for this content: its JSON as the content, its routing tags and the envelope. Refuses a network
 * the kind does not allow (a derived one is filled in) and content its kind's check rejects.
 */
export const buildSidequestEvent = Effect.fnUntraced(function* <C>(
  spec: KindSpec<C>,
  content: C,
  options: BuildOptions,
): Effect.fn.Return<EventTemplate, VocabularyRefused> {
  const network = settledNetwork(spec, content, Option.fromNullishOr(options.network))
  if (Option.isNone(network)) return yield* refused('networkMismatch')
  yield* checkContent(spec, content)
  const json = yield* Schema.encodeEffect(Schema.fromJsonString(spec.content))(content).pipe(
    Effect.mapError(() => refused('badContent')),
  )
  const envelope = { network: network.value, grant: Option.fromNullishOr(options.grant) }
  return { created_at: options.createdAt, kind: spec.kind, tags: expectedTags(spec, content, envelope), content: json }
})

/**
 * Verifies an event and reads it as this kind: the signature and recomputed id, the kind, the content against its
 * schema, the envelope, the network rule, every tag the content and envelope imply with its exact values and no other
 * routing tag (see `impliedTagsMatch`; other clients' harmless tags are ignored), and the kind's own check. Never
 * trusts a routing tag the content does not imply.
 */
export const parseSidequestEvent = Effect.fnUntraced(function* <C>(
  spec: KindSpec<C>,
  input: unknown,
): Effect.fn.Return<ParsedEvent<C>, VocabularyRefused> {
  const event = yield* Effect.fromResult(verifyEvent(input)).pipe(Effect.mapError(() => refused('invalidEvent')))
  if (event.kind !== spec.kind) return yield* refused('wrongKind')
  const content = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(spec.content))(event.content).pipe(
    Effect.mapError(() => refused('badContent')),
  )
  const envelope = readEnvelope(event)
  if (envelope === undefined) return yield* refused('badEnvelope')
  if (Option.isNone(settledNetwork(spec, content, envelope.network))) return yield* refused('networkMismatch')
  if (!impliedTagsMatch(event.tags, expectedTags(spec, content, envelope))) return yield* refused('tagMismatch')
  yield* checkContent(spec, content)
  return { event, content, envelope }
})
