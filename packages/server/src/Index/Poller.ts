import { standardKinds } from '@sidequest/nostr/vocabulary'
import type { Unavailable } from '@sidequest/protocol'
import { Context, Effect, Layer, Option, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'
import { stored } from '@sidequest/serving/Stored'
import { EventStore } from './EventStore.ts'
import { IndexSettings, type RelayTiming } from './IndexConfig.ts'
import { Ingest, nowSeconds } from './Ingest.ts'
import { connectRelay, keyAuth, type RelayConnection, type RelayFailure } from '@sidequest/nostr/relay'
import type { Filter } from '@sidequest/nostr/relay'
import { indexedKinds } from './Validation.ts'

/** Where a relay's reading stands: the start of its last complete pass, its failures since, and when to try again. */
const Cursor = Schema.Struct({
  lastRunStart: Schema.NullOr(Schema.Int),
  failures: Schema.Int,
  retryAfter: Schema.Int,
})
type Cursor = typeof Cursor.Type

const fresh: Cursor = { lastRunStart: null, failures: 0, retryAfter: 0 }

/** Seconds before a relay that failed `failures` times in a row is tried again: a minute, doubling, at most a day. */
export const relayBackoffSeconds = (failures: number) => Math.min(60 * 2 ** Math.max(failures - 1, 0), 86_400)

/** Kinds every author may sign that the index keeps, read from relays by kind alone. */
const derivingKinds = new Set<number>([standardKinds.profile, standardKinds.relayList, standardKinds.messagingRelays])

/** Authors per filter when asking for profiles and relay lists. */
const authorsPerFilter = 100

/** The most authors whose profiles and relay lists the poller asks for. */
const maxAuthors = 1000

/**
 * The filters one pass reads: Sidequest's kinds and listings by kind, and the profiles and relay lists of the keys that
 * signed Sidequest events, by author: everyone's profiles would be most of a public relay.
 */
export const streamsFor = (authors: ReadonlyArray<string>, since: number): ReadonlyArray<Filter> => {
  const byKind = indexedKinds.filter((kind) => !derivingKinds.has(kind))
  const chunks = Array.from({ length: Math.ceil(authors.length / authorsPerFilter) }, (_, index) =>
    authors.slice(index * authorsPerFilter, (index + 1) * authorsPerFilter),
  )
  return [{ kinds: byKind, since }, ...chunks.map((chunk) => ({ kinds: [...derivingKinds], authors: chunk, since }))]
}

const CreatedAt = Schema.Struct({ id: Schema.String, created_at: Schema.Int })
const stamp = Schema.decodeUnknownOption(CreatedAt)

/**
 * Reads one filter backwards, page by page: each page asks for events up to the oldest the page before held
 * (inclusive, so a second split across two pages is read whole), until a page brings no event this stream had not
 * seen. That never depends on the relay honouring `limit`, which many cap lower. `true` when it read to the end,
 * `false` when it stopped at `maxPages`.
 */
const readStream = Effect.fnUntraced(function* (
  connection: RelayConnection,
  filter: Filter,
  timing: RelayTiming,
  ingest: (event: unknown) => Effect.Effect<void, Unavailable>,
) {
  const seen = new Set<string>()
  let until: number | undefined = undefined
  for (let page = 0; page < timing.maxPages; page += 1) {
    const events = yield* connection.query({
      ...filter,
      limit: timing.pageLimit,
      ...(until === undefined ? {} : { until }),
    })
    const stamps = events.flatMap((event) => Option.toArray(stamp(event)))
    const unseen = stamps.filter(({ id }) => !seen.has(id))
    if (unseen.length === 0) return true
    for (const { id } of unseen) seen.add(id)
    yield* Effect.forEach(events, ingest, { discard: true })
    until = Math.min(...stamps.map(({ created_at }) => created_at))
  }
  return false
})

/** What one relay's pass came to. */
export type PassOutcome = 'complete' | 'incomplete' | 'failed' | 'waiting'

/**
 * The relay poller. Each run reads every configured relay (four at a time) for the kinds the index keeps, from the
 * start of that relay's last complete pass less the overlap (or, the first time, from now less the overlap), and
 * ingests what it finds: duplicates are found by id, refusals skipped. A relay's cursor moves only when every stream
 * of its pass read to the end. A relay that fails is skipped until its backoff ends, and never holds up another. A
 * pass cut short (a restart, a timeout) leaves the cursor where it was, so the next run reads the same span again,
 * which ingestion makes harmless.
 */
export class Poller extends Context.Service<
  Poller,
  { readonly run: Effect.Effect<ReadonlyMap<string, PassOutcome>, Unavailable> }
>()('Sidequest/Index/Poller') {
  /** On D1; needs the database's `SqlClient`, `Ingest`, the `EventStore` and the `IndexSettings`. */
  static readonly layer = Layer.effect(
    Poller,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const ingest = yield* Ingest
      const events = yield* EventStore
      const settings = yield* IndexSettings
      const load = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: Cursor,
        execute: (relay) => sql`
          SELECT last_run_start AS lastRunStart, failures, retry_after AS retryAfter
          FROM relay_cursors WHERE relay = ${relay}`,
      })
      const completed = (relay: string, runStart: number) => sql`
        INSERT INTO relay_cursors (relay, last_run_start, failures, retry_after) VALUES (${relay}, ${runStart}, 0, 0)
        ON CONFLICT (relay) DO UPDATE SET last_run_start = MAX(COALESCE(relay_cursors.last_run_start, 0),
          excluded.last_run_start), failures = 0, retry_after = 0`
      const failed = (relay: string, cursor: Cursor, now: number) => {
        const failures = cursor.failures + 1
        return sql`
          INSERT INTO relay_cursors (relay, last_run_start, failures, retry_after)
          VALUES (${relay}, NULL, ${failures}, ${now + relayBackoffSeconds(failures)})
          ON CONFLICT (relay) DO UPDATE SET failures = excluded.failures, retry_after = excluded.retry_after`
      }
      const pass = (relay: string, since: number, authors: ReadonlyArray<string>) =>
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* connectRelay(relay, {
              ...settings.timing,
              auth: Option.map(settings.authKey, keyAuth),
            })
            const ingestFrom = (event: unknown) =>
              ingest.ingest(event, `relay:${relay}`).pipe(
                Effect.asVoid,
                Effect.catchTag('EventRefused', () => Effect.void),
              )
            const complete = yield* Effect.forEach(streamsFor(authors, since), (filter) =>
              readStream(connection, filter, settings.timing, ingestFrom),
            )
            return complete.every(Boolean)
          }),
        )
      const pollRelay = Effect.fnUntraced(function* (relay: string, runStart: number, authors: ReadonlyArray<string>) {
        const cursor = Option.getOrElse(yield* stored(load(relay)), () => fresh)
        if (runStart < cursor.retryAfter) return 'waiting' as const
        const since = (cursor.lastRunStart ?? runStart) - settings.overlapSeconds
        const outcome = yield* pass(relay, since, authors).pipe(
          Effect.map((complete) => (complete ? ('complete' as const) : ('incomplete' as const))),
          Effect.catchTag('RelayFailure', (failure: RelayFailure) =>
            Effect.logWarning('Sidequest.Index relay failed').pipe(
              Effect.annotateLogs({ 'sidequest.relay': relay, 'sidequest.relay.failure': failure.reason }),
              Effect.as('failed' as const),
            ),
          ),
        )
        if (outcome === 'complete') yield* stored(completed(relay, runStart))
        if (outcome === 'failed') yield* stored(failed(relay, cursor, runStart))
        return outcome
      })
      return Poller.of({
        run: Effect.gen(function* () {
          if (settings.relays.length === 0) return new Map<string, PassOutcome>()
          const runStart = yield* nowSeconds
          const authors = yield* events.authors(maxAuthors)
          const outcomes = yield* Effect.forEach(
            settings.relays,
            (relay) =>
              pollRelay(relay, runStart, authors).pipe(
                // A store that fails for one relay fails that relay's pass only.
                Effect.catchTag('Unavailable', () => Effect.succeed('failed' as const)),
                Effect.map((outcome) => [relay, outcome] as const),
              ),
            { concurrency: 4 },
          )
          return new Map(outcomes)
        }).pipe(Effect.withSpan('Sidequest.Index.poll')),
      })
    }),
  )
}
