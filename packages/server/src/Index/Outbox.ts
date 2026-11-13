import type { NostrEvent } from '@sidequest/nostr'
import type { Unavailable } from '@sidequest/protocol'
import { Context, Effect, Layer, Option, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'
import { stored } from '../SignIn/Stored.ts'
import { EventStore } from './EventStore.ts'
import { IndexSettings, maxAuthorRelays } from './IndexConfig.ts'
import { nowSeconds } from './Ingest.ts'
import { connectRelay, type RelayFailure } from './RelayClient.ts'
import type { OkReply } from './RelayFrames.ts'
import { allowedRelays } from './RelayUrls.ts'

/** What a relay's answer means for a delivery: done (`duplicate:` included), refused for good, or try again later. */
export type Delivery = 'delivered' | 'refused' | 'retry'

// NIP-01's machine-readable prefixes for a refusal that sending again will not change.
const permanent = ['invalid:', 'blocked:', 'pow:', 'restricted:']

/** How a relay's `OK` settles a delivery. */
export const deliveryOf = (reply: OkReply): Delivery => {
  if (reply.accepted || reply.message.startsWith('duplicate:')) return 'delivered'
  return permanent.some((prefix) => reply.message.startsWith(prefix)) ? 'refused' : 'retry'
}

/** A delivery is tried at most this many times; then it is abandoned. */
export const maxAttempts = 10

/** Seconds before attempt `attempts + 1`: 30 s, doubling, at most six hours. */
export const retryDelaySeconds = (attempts: number) => Math.min(30 * 2 ** Math.max(attempts - 1, 0), 6 * 3600)

/** How many due deliveries one run takes on. */
const batchSize = 100

/** Rows by relay, in the order rows first name each relay. */
const byRelay = (rows: ReadonlyArray<Due>) => {
  const groups = new Map<string, Array<Due>>()
  for (const row of rows) groups.set(row.relay, [...(groups.get(row.relay) ?? []), row])
  return [...groups]
}

const Due = Schema.Struct({ eventId: Schema.String, relay: Schema.String, attempts: Schema.Int })
type Due = typeof Due.Type

/** What one run did, by outcome. */
export interface DeliveryRun {
  readonly delivered: number
  readonly refused: number
  readonly retried: number
}

/**
 * Events accepted through publish-through, on their way to relays (`outbox` on D1). `enqueue` records one row per
 * relay the event must reach: the stage's default relays and, when it has them, the author's own write relays from
 * their latest NIP-65 list (at most four, under the same URL rule). With no default relays the index relays nothing.
 * Enqueuing twice changes nothing. `deliver` takes the due rows, opens one connection per relay, and settles each row
 * by the relay's answer; each settlement guards the attempt it read, so two runs that overlap never count one twice.
 */
export class Outbox extends Context.Service<
  Outbox,
  {
    readonly enqueue: (event: NostrEvent) => Effect.Effect<void, Unavailable>
    readonly deliver: Effect.Effect<DeliveryRun, Unavailable>
  }
>()('Sidequest/Index/Outbox') {
  /** On D1; needs the database's `SqlClient`, the `EventStore` and the `IndexSettings`. */
  static readonly layer = Layer.effect(
    Outbox,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const events = yield* EventStore
      const settings = yield* IndexSettings
      const due = SqlSchema.findAll({
        Request: Schema.Int,
        Result: Due,
        execute: (now) => sql`
          SELECT event_id AS eventId, relay, attempts FROM outbox
          WHERE state = 'pending' AND next_attempt_at <= ${now}
          ORDER BY next_attempt_at, event_id, relay LIMIT ${batchSize}`,
      })
      const settle = (row: Due, outcome: Delivery, now: number, error: string | null) => {
        const attempts = row.attempts + 1
        const state = outcome === 'retry' ? (attempts >= maxAttempts ? 'abandoned' : 'pending') : outcome
        return sql`
          UPDATE outbox SET state = ${state}, attempts = ${attempts}, last_error = ${error},
            next_attempt_at = ${now + retryDelaySeconds(attempts)}
          WHERE event_id = ${row.eventId} AND relay = ${row.relay} AND state = 'pending' AND attempts = ${row.attempts}`
      }
      const targets = Effect.fnUntraced(function* (event: NostrEvent) {
        if (settings.relays.length === 0) return []
        const known = yield* events.known(event.pubkey)
        const own = Option.match(known.relayList, { onNone: () => [], onSome: (list) => list.write })
        return [...new Set([...settings.relays, ...allowedRelays(own, settings.policy, maxAuthorRelays)])]
      })
      const publishAll = (relay: string, rows: ReadonlyArray<Due>) =>
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* connectRelay(relay, { ...settings.timing, authKey: settings.authKey })
            return yield* Effect.forEach(rows, (row) =>
              Effect.flatMap(events.find(row.eventId), (event) =>
                Option.match(event, {
                  // An outbox row always names a stored event; one that does not is refused.
                  onNone: () => Effect.succeed({ row, outcome: 'refused' as const, error: 'missing event' }),
                  onSome: (found) =>
                    connection
                      .publish(found)
                      .pipe(Effect.map((reply) => ({ row, outcome: deliveryOf(reply), error: reply.message }))),
                }),
              ),
            )
          }),
        )
      const deliverTo = (relay: string, rows: ReadonlyArray<Due>, now: number) =>
        publishAll(relay, rows).pipe(
          Effect.catchTag('RelayFailure', (failure: RelayFailure) =>
            Effect.succeed(rows.map((row) => ({ row, outcome: 'retry' as const, error: failure.reason }))),
          ),
          Effect.tap((settled) =>
            stored(
              Effect.forEach(settled, ({ row, outcome, error }) => settle(row, outcome, now, error), { discard: true }),
            ),
          ),
        )
      return Outbox.of({
        enqueue: Effect.fn('Sidequest.Index.enqueue')(function* (event) {
          const relays = yield* targets(event)
          if (relays.length === 0) return
          const now = yield* nowSeconds
          yield* stored(sql`
            INSERT INTO outbox (event_id, relay, next_attempt_at)
            SELECT ${event.id}, value, ${now} FROM json_each(${JSON.stringify(relays)}) WHERE true
            ON CONFLICT DO NOTHING`)
        }),
        deliver: Effect.gen(function* () {
          const now = yield* nowSeconds
          const rows = yield* stored(due(now))
          const settled = yield* Effect.forEach(byRelay(rows), ([relay, group]) => deliverTo(relay, group, now), {
            concurrency: 4,
          })
          const outcomes = settled.flat().map(({ outcome }) => outcome)
          const count = (outcome: Delivery) => outcomes.filter((found) => found === outcome).length
          return { delivered: count('delivered'), refused: count('refused'), retried: count('retry') }
        }).pipe(Effect.withSpan('Sidequest.Index.deliver')),
      })
    }),
  )
}
