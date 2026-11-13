import type { NostrEvent } from '@sidequest/nostr'
import type { Unavailable } from '@sidequest/protocol'
import { Clock, Context, Effect, Layer } from 'effect'
import { EventStore, type Source } from './EventStore.ts'
import { type EventRefused, validateEvent, type Validated } from './Validation.ts'

/** An event the index keeps: stored by this call, or a duplicate of one it stored before. */
export interface Accepted {
  readonly event: NostrEvent
  readonly status: 'stored' | 'duplicate'
}

/** Now, in Unix seconds, from Effect's clock. */
export const nowSeconds = Effect.map(Clock.currentTimeMillis, (millis) => Math.floor(millis / 1000))

/**
 * The index's way in: `ingest` validates an event (the pure `validateEvent`) and stores it with what it derives, and
 * answers stored or duplicate, or refuses it with the reason. `store` is its second half, for a caller that checks
 * something between the two (publish-through limits each key only once its signature verified).
 */
export class Ingest extends Context.Service<
  Ingest,
  {
    readonly ingest: (input: unknown, source: Source) => Effect.Effect<Accepted, EventRefused | Unavailable>
    readonly store: (validated: Validated, source: Source) => Effect.Effect<Accepted, Unavailable>
  }
>()('Sidequest/Index/Ingest') {
  /** Over the D1 tables; needs the `EventStore`. */
  static readonly layer = Layer.effect(
    Ingest,
    Effect.gen(function* () {
      const events = yield* EventStore
      const store = Effect.fn('Sidequest.Index.store')(function* (validated: Validated, source: Source) {
        yield* Effect.annotateCurrentSpan({ 'nostr.kind': validated.event.kind, 'sidequest.index.source': source })
        const inserted = yield* events.put(validated, source, yield* nowSeconds)
        return { event: validated.event, status: inserted ? 'stored' : 'duplicate' } satisfies Accepted
      })
      return Ingest.of({
        store,
        ingest: (input, source) => Effect.flatMap(validateEvent(input), (validated) => store(validated, source)),
      })
    }),
  )
}
