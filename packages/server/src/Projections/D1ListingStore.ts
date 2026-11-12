import { ListingStore, ListingRow, type ListingChange } from '@sidequest/domain/Directory/ListingStore'
import { ListingId } from '@sidequest/protocol'
import { Effect, Layer, Match, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

/** A listing row as D1 holds it: its tags as a JSON array. */
const StoredListing = Schema.Struct({ ...ListingRow.fields, tags: Schema.fromJsonString(ListingRow.fields.tags) })

/**
 * The `listings` table behind the `Listings` projection. Each change is one statement that writes only when its
 * version is newer than the row's, so a redelivered change does nothing; an update or withdrawal of a listing the
 * table has not seen published shows nothing but keeps its version. D1 failing is a defect: the projection's delivery
 * is retried.
 */
export const D1ListingStore = Layer.effect(
  ListingStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const write = (change: ListingChange) =>
      Match.valueTags(change, {
        Published: ({ id, owner, title, tags, version }) => sql`
          INSERT INTO listings (id, owner, title, tags, state, version)
          VALUES (${id}, ${owner}, ${title}, ${JSON.stringify(tags)}, 'published', ${version})
          ON CONFLICT (id) DO UPDATE SET
            owner = excluded.owner, title = excluded.title, tags = excluded.tags, state = excluded.state,
            version = excluded.version
          WHERE excluded.version > listings.version`,
        // A listing the table has not seen published keeps only the version, as a row without a state.
        Updated: ({ id, title, tags, version }) => sql`
          INSERT INTO listings (id, version) VALUES (${id}, ${version})
          ON CONFLICT (id) DO UPDATE SET title = ${title}, tags = ${JSON.stringify(tags)}, version = excluded.version
          WHERE excluded.version > listings.version`,
        Withdrawn: ({ id, version }) => sql`
          INSERT INTO listings (id, version) VALUES (${id}, ${version})
          ON CONFLICT (id) DO UPDATE SET
            state = CASE WHEN listings.state IS NULL THEN NULL ELSE 'withdrawn' END, version = excluded.version
          WHERE excluded.version > listings.version`,
      })
    const find = SqlSchema.findOneOption({
      Request: ListingId,
      Result: StoredListing,
      execute: (id) =>
        sql`SELECT id, owner, title, tags, state, version FROM listings WHERE id = ${id} AND state IS NOT NULL`,
    })
    return ListingStore.of({
      apply: Effect.fn('Sidequest.Listings.apply')(function* (changes) {
        yield* Effect.forEach(changes, write, { discard: true }).pipe(Effect.orDie)
      }),
      get: Effect.fn('Sidequest.Listings.get')(function* (id) {
        return yield* find(id).pipe(Effect.orDie)
      }),
    })
  }),
)
