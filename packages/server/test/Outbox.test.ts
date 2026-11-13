import { it } from '@effect/vitest'
import type { NostrEvent } from '@sidequest/nostr'
import { Effect } from 'effect'
import { describe, expect } from 'vitest'
import { Ingest } from '../src/Index/Ingest.ts'
import { maxAttempts, Outbox } from '../src/Index/Outbox.ts'
import { alice, indexWorld, relayList, relaying, request } from './IndexWorld.ts'
import { withRelays } from './TestRelay.ts'

const now = () => Math.floor(Date.now() / 1000)

/** An index relaying to `urls`: publish an event through it, run the outbox, and read the rows. */
const outboxFor = (urls: ReadonlyArray<string>) => {
  const { sqlite, layer } = indexWorld(relaying(urls))
  const publish = (event: NostrEvent) =>
    Effect.gen(function* () {
      yield* Effect.flatMap(Ingest, (index) => index.ingest(event, 'publish'))
      yield* Effect.flatMap(Outbox, (outbox) => outbox.enqueue(event))
    }).pipe(Effect.provide(layer))
  const deliver = Effect.flatMap(Outbox, (outbox) => outbox.deliver).pipe(Effect.provide(layer))
  const rows = () => sqlite.prepare('SELECT relay, state, attempts FROM outbox ORDER BY relay').all()
  const due = () => sqlite.exec('UPDATE outbox SET next_attempt_at = 0')
  return { publish, deliver, rows, due, sqlite }
}

describe('the outbox', () => {
  it.live('delivers an event to every default relay, once', () =>
    withRelays([{}, {}], ([one, two]) =>
      Effect.gen(function* () {
        if (one === undefined || two === undefined) return
        const outbox = outboxFor([one.url, two.url])
        const event = request(alice, now())
        yield* outbox.publish(event)
        yield* outbox.publish(event)
        expect(yield* outbox.deliver).toEqual({ delivered: 2, refused: 0, retried: 0 })
        expect([one.published, two.published]).toEqual([[event.id], [event.id]])
        expect(outbox.rows().map((row) => row['state'])).toEqual(['delivered', 'delivered'])
        expect(yield* outbox.deliver).toEqual({ delivered: 0, refused: 0, retried: 0 })
      }),
    ),
  )

  it.live('retries later after a failure, with backoff, until the relay takes it', () =>
    withRelays([{ refuse: () => 'error: busy' }, { unreachable: true }], ([busy, down]) =>
      Effect.gen(function* () {
        if (busy === undefined || down === undefined) return
        const outbox = outboxFor([busy.url, down.url])
        yield* outbox.publish(request(alice, now()))
        expect(yield* outbox.deliver).toEqual({ delivered: 0, refused: 0, retried: 2 })
        expect(outbox.rows().map((row) => [row['state'], row['attempts']])).toEqual([
          ['pending', 1],
          ['pending', 1],
        ])
        // Not due yet: the backoff holds them.
        expect(yield* outbox.deliver).toEqual({ delivered: 0, refused: 0, retried: 0 })
        busy.behaviour.refuse = () => undefined
        down.behaviour.unreachable = false
        outbox.due()
        expect(yield* outbox.deliver).toEqual({ delivered: 2, refused: 0, retried: 0 })
      }),
    ),
  )

  it.live('counts duplicate: as delivered, whether the relay says true or false', () =>
    withRelays([{}, { refuse: () => 'duplicate: seen it' }], ([seeded, refusing]) =>
      Effect.gen(function* () {
        if (seeded === undefined || refusing === undefined) return
        const event = request(alice, now())
        seeded.seed(event)
        const outbox = outboxFor([seeded.url, refusing.url])
        yield* outbox.publish(event)
        expect(yield* outbox.deliver).toEqual({ delivered: 2, refused: 0, retried: 0 })
      }),
    ),
  )

  it.live('gives up on a permanent refusal at once, and on a failing relay after the last attempt', () =>
    withRelays([{ refuse: () => 'blocked: not you' }, { refuse: () => 'error: busy' }], ([blocking, busy]) =>
      Effect.gen(function* () {
        if (blocking === undefined || busy === undefined) return
        const outbox = outboxFor([blocking.url, busy.url])
        yield* outbox.publish(request(alice, now()))
        expect(yield* outbox.deliver).toEqual({ delivered: 0, refused: 1, retried: 1 })
        for (let attempt = 2; attempt <= maxAttempts; attempt += 1) {
          outbox.due()
          yield* outbox.deliver
        }
        const byRelay = Object.fromEntries(
          outbox.rows().map((row): [string, unknown] => [String(row['relay']), [row['state'], row['attempts']]]),
        )
        expect(byRelay).toEqual({ [blocking.url]: ['refused', 1], [busy.url]: ['abandoned', maxAttempts] })
      }),
    ),
  )

  it.live('also delivers to the author’s own write relays from their latest relay list', () =>
    withRelays([{}, {}, {}], ([stage, own, readOnly]) =>
      Effect.gen(function* () {
        if (stage === undefined || own === undefined || readOnly === undefined) return
        const outbox = outboxFor([stage.url])
        const list = relayList(alice, now() - 10, { read: [readOnly.url], write: [own.url] })
        yield* outbox.publish(list)
        const event = request(alice, now())
        yield* outbox.publish(event)
        yield* outbox.deliver
        const both = [list.id, event.id].toSorted()
        expect(stage.published.toSorted()).toEqual(both)
        expect(own.published.toSorted()).toEqual(both)
        expect(readOnly.published).toEqual([])
      }),
    ),
  )

  it.live('relays nothing, not even to an author’s own relays, when the stage names no relays', () =>
    withRelays([{}], ([own]) =>
      Effect.gen(function* () {
        if (own === undefined) return
        const outbox = outboxFor([])
        yield* outbox.publish(relayList(alice, now() - 10, { read: [], write: [own.url] }))
        yield* outbox.publish(request(alice, now()))
        expect(outbox.rows()).toEqual([])
        expect(yield* outbox.deliver).toEqual({ delivered: 0, refused: 0, retried: 0 })
        expect(own.published).toEqual([])
      }),
    ),
  )
})
