import { ListingStore, ListingRow, type ListingChange } from '@sidequest/domain/Directory/ListingStore'
import { ListingId, PriceHint } from '@sidequest/protocol'
import { Effect, Layer, Match, Option, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

/** A listing row as D1 holds it: its tags as a JSON array, its price hint as JSON or null. */
export const StoredListing = Schema.Struct({
  ...ListingRow.fields,
  tags: Schema.fromJsonString(ListingRow.fields.tags),
  priceHint: Schema.NullOr(Schema.fromJsonString(PriceHint)),
})

/** The row a stored listing is: a listing without a price hint has none. */
export const listingRowOf = ({ priceHint, ...row }: typeof StoredListing.Type): ListingRow =>
  priceHint === null ? row : { ...row, priceHint }

/** The columns {@link StoredListing} reads. */
export const listingColumns = 'id, owner, title, description, tags, price_hint AS priceHint, state, version'

const priceHintJson = (priceHint: PriceHint | undefined) => (priceHint === undefined ? null : JSON.stringify(priceHint))

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
        Published: ({ id, owner, title, description, tags, priceHint, version }) => sql`
          INSERT INTO listings (id, owner, title, description, tags, price_hint, state, version)
          VALUES (${id}, ${owner}, ${title}, ${description}, ${JSON.stringify(tags)}, ${priceHintJson(priceHint)},
            'published', ${version})
          ON CONFLICT (id) DO UPDATE SET
            owner = excluded.owner, title = excluded.title, description = excluded.description, tags = excluded.tags,
            price_hint = excluded.price_hint, state = excluded.state, version = excluded.version
          WHERE excluded.version > listings.version`,
        // A listing the table has not seen published keeps only the version, as a row without a state.
        Updated: ({ id, title, description, tags, priceHint, version }) => sql`
          INSERT INTO listings (id, version) VALUES (${id}, ${version})
          ON CONFLICT (id) DO UPDATE SET
            title = ${title}, description = ${description}, tags = ${JSON.stringify(tags)},
            price_hint = ${priceHintJson(priceHint)}, version = excluded.version
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
      execute: (id) => sql`SELECT ${sql.literal(listingColumns)} FROM listings WHERE id = ${id} AND state IS NOT NULL`,
    })
    return ListingStore.of({
      apply: Effect.fn('Sidequest.Listings.apply')(function* (changes) {
        yield* Effect.forEach(changes, write, { discard: true }).pipe(Effect.orDie)
      }),
      get: Effect.fn('Sidequest.Listings.get')(function* (id) {
        return (yield* find(id).pipe(Effect.orDie)).pipe(Option.map(listingRowOf))
      }),
    })
  }),
)
