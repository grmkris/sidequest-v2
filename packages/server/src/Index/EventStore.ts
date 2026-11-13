import { NostrEvent } from '@sidequest/nostr'
import { standardKinds } from '@sidequest/nostr/vocabulary'
import type { Unavailable } from '@sidequest/protocol'
import { Context, Effect, Layer, Option, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'
import { stored } from '../SignIn/Stored.ts'
import type { Derived, ProfileRow, RelayListRow } from './Derived.ts'
import { validateEvent, type Validated } from './Validation.ts'

/** Where an event was first seen: published through the API, or read from a relay. */
export type Source = 'publish' | `relay:${string}`

const Tags = Schema.fromJsonString(NostrEvent.fields.tags)
const EventRow = Schema.Struct({ ...NostrEvent.fields, tags: Tags })
const Urls = Schema.fromJsonString(Schema.Array(Schema.String))
const ProfileRecord = Schema.Struct({
  pubkey: Schema.String,
  eventId: Schema.String,
  createdAt: Schema.Int,
  name: Schema.NullOr(Schema.String),
  about: Schema.NullOr(Schema.String),
  picture: Schema.NullOr(Schema.String),
})
const RelayListRecord = Schema.Struct({
  pubkey: Schema.String,
  kind: Schema.Int,
  eventId: Schema.String,
  createdAt: Schema.Int,
  read: Urls,
  write: Urls,
})

/** What the index knows of one key: its latest profile and relay lists, each when it has seen one. */
export interface Known {
  readonly profile: Option.Option<ProfileRow>
  readonly relayList: Option.Option<RelayListRow>
  readonly messagingRelays: Option.Option<RelayListRow>
}

/**
 * The index's tables on D1: `events` and `event_tags`, and the latest-per-key tables derived from them, `profiles` and
 * `relay_lists`. D1 runs each statement on its own, so every write here is one idempotent statement and a write cut
 * short is repaired by doing it again: storing an event that is there already still indexes its tags and applies what
 * it derives. A derived row is replaced only by an event that supersedes it (`supersedes`), decided in the statement
 * itself, so the tables come out the same whatever order events arrive in.
 */
export class EventStore extends Context.Service<
  EventStore,
  {
    /** Stores a valid event: `true` when this call stored it, `false` when it was there already. */
    readonly put: (validated: Validated, source: Source, seenAt: number) => Effect.Effect<boolean, Unavailable>
    readonly find: (id: string) => Effect.Effect<Option.Option<NostrEvent>, Unavailable>
    readonly known: (pubkey: string) => Effect.Effect<Known, Unavailable>
    /** Keys that signed Sidequest events or listings, whose profiles and relay lists the poller asks relays for. */
    readonly authors: (limit: number) => Effect.Effect<ReadonlyArray<string>, Unavailable>
    /** Rebuilds `profiles` and `relay_lists` from `events` alone, as if every stored event had just arrived. */
    readonly rebuild: Effect.Effect<void, Unavailable>
  }
>()('Sidequest/Index/EventStore') {}

const writes = (sql: SqlClient.SqlClient) => {
  const insertEvent = ({ event, validation }: Validated, source: Source, seenAt: number) =>
    sql<{ readonly id: string }>`
      INSERT INTO events (id, pubkey, kind, created_at, content, tags, sig, first_seen, source, validation)
      VALUES (${event.id}, ${event.pubkey}, ${event.kind}, ${event.created_at}, ${event.content},
        ${JSON.stringify(event.tags)}, ${event.sig}, ${seenAt}, ${source}, ${validation})
      ON CONFLICT (id) DO NOTHING
      RETURNING id`
  // Every tag with a value, by position, in one statement.
  const indexTags = (event: NostrEvent) => sql`
    INSERT INTO event_tags (event_id, position, name, value)
    SELECT ${event.id}, key, json_extract(value, '$[0]'), json_extract(value, '$[1]')
    FROM json_each(${JSON.stringify(event.tags)}) WHERE json_array_length(value) >= 2
    ON CONFLICT DO NOTHING`
  const profile = (row: ProfileRow) => sql`
    INSERT INTO profiles (pubkey, event_id, created_at, name, about, picture)
    VALUES (${row.pubkey}, ${row.eventId}, ${row.createdAt}, ${row.name}, ${row.about}, ${row.picture})
    ON CONFLICT (pubkey) DO UPDATE SET event_id = excluded.event_id, created_at = excluded.created_at,
      name = excluded.name, about = excluded.about, picture = excluded.picture
    -- Replaced only by an event that supersedes it: later, or as old with a lower id.
    WHERE excluded.created_at > profiles.created_at
      OR (excluded.created_at = profiles.created_at AND excluded.event_id < profiles.event_id)`
  const relayList = (row: RelayListRow) => sql`
    INSERT INTO relay_lists (pubkey, kind, event_id, created_at, read, write)
    VALUES (${row.pubkey}, ${row.kind}, ${row.eventId}, ${row.createdAt}, ${JSON.stringify(row.read)},
      ${JSON.stringify(row.write)})
    ON CONFLICT (pubkey, kind) DO UPDATE SET event_id = excluded.event_id, created_at = excluded.created_at,
      read = excluded.read, write = excluded.write
    -- Replaced only by an event that supersedes it: later, or as old with a lower id.
    WHERE excluded.created_at > relay_lists.created_at
      OR (excluded.created_at = relay_lists.created_at AND excluded.event_id < relay_lists.event_id)`
  const apply = (derived: Derived) => (derived.table === 'profiles' ? profile(derived.row) : relayList(derived.row))
  return { insertEvent, indexTags, apply }
}

const reads = (sql: SqlClient.SqlClient) => {
  const event = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: EventRow,
    execute: (id) => sql`SELECT id, pubkey, created_at, kind, tags, content, sig FROM events WHERE id = ${id}`,
  })
  const profile = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: ProfileRecord,
    execute: (pubkey) => sql`
      SELECT pubkey, event_id AS eventId, created_at AS createdAt, name, about, picture
      FROM profiles WHERE pubkey = ${pubkey}`,
  })
  const relayLists = SqlSchema.findAll({
    Request: Schema.String,
    Result: RelayListRecord,
    execute: (pubkey) => sql`
      SELECT pubkey, kind, event_id AS eventId, created_at AS createdAt, read, write
      FROM relay_lists WHERE pubkey = ${pubkey}`,
  })
  const authors = SqlSchema.findAll({
    Request: Schema.Int,
    Result: Schema.Struct({ pubkey: Schema.String }),
    execute: (limit) => sql`
      SELECT pubkey FROM events WHERE validation IN ('sidequest', 'listing')
      GROUP BY pubkey ORDER BY MAX(created_at) DESC LIMIT ${limit}`,
  })
  // Keyset pages of the events that derive something, for a rebuild.
  const derivingPage = SqlSchema.findAll({
    Request: Schema.String,
    Result: EventRow,
    execute: (after) => sql`
      SELECT id, pubkey, created_at, kind, tags, content, sig FROM events
      WHERE validation IN ('profile', 'relayList', 'messagingRelays') AND id > ${after}
      ORDER BY id LIMIT ${rebuildPage}`,
  })
  return { event, profile, relayLists, authors, derivingPage }
}

const rebuildPage = 200

const kindOf = (rows: ReadonlyArray<RelayListRow>, kind: number) =>
  Option.fromUndefinedOr(rows.find((row) => row.kind === kind))

/** The index's tables on D1; needs the database's `SqlClient`. */
export const D1EventStore = Layer.effect(
  EventStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const { insertEvent, indexTags, apply } = writes(sql)
    const read = reads(sql)
    const rederive = (row: NostrEvent) =>
      validateEvent(row).pipe(
        Effect.flatMap(({ derived }) => Effect.forEach(Option.toArray(derived), apply, { discard: true })),
        // A stored event always validates again; one that no longer would derives nothing.
        Effect.catchTag('EventRefused', () => Effect.void),
      )
    const rebuildFrom = (after: string): Effect.Effect<void, Unavailable> =>
      stored(read.derivingPage(after)).pipe(
        Effect.tap((page) => stored(Effect.forEach(page, rederive, { discard: true }))),
        Effect.flatMap((page) => {
          const last = page.at(-1)
          return page.length < rebuildPage || last === undefined ? Effect.void : rebuildFrom(last.id)
        }),
      )
    return EventStore.of({
      put: Effect.fn('Sidequest.Index.put')(function* (validated, source, seenAt) {
        const inserted = yield* stored(insertEvent(validated, source, seenAt))
        yield* stored(indexTags(validated.event))
        yield* stored(Effect.forEach(Option.toArray(validated.derived), apply, { discard: true }))
        return inserted.length > 0
      }),
      find: Effect.fn('Sidequest.Index.find')(function* (id) {
        return yield* stored(read.event(id))
      }),
      known: Effect.fn('Sidequest.Index.known')(function* (pubkey) {
        const profile = yield* stored(read.profile(pubkey))
        const lists = yield* stored(read.relayLists(pubkey))
        return {
          profile,
          relayList: kindOf(lists, standardKinds.relayList),
          messagingRelays: kindOf(lists, standardKinds.messagingRelays),
        }
      }),
      authors: (limit) =>
        stored(read.authors(limit)).pipe(
          Effect.map((rows) => rows.map(({ pubkey }) => pubkey)),
          Effect.withSpan('Sidequest.Index.authors'),
        ),
      rebuild: Effect.gen(function* () {
        yield* stored(sql`DELETE FROM profiles`)
        yield* stored(sql`DELETE FROM relay_lists`)
        yield* rebuildFrom('')
      }).pipe(Effect.withSpan('Sidequest.Index.rebuild')),
    })
  }),
)
