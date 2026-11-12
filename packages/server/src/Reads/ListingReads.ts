import type { ListingRow } from '@sidequest/domain/Directory/ListingStore'
import { AccountId, type BadCursor, type Cursor, type Listing, ListingId, type Unavailable } from '@sidequest/protocol'
import { Context, Effect, Layer, Option, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'
import { listingColumns, listingRowOf, StoredListing } from '../Projections/D1ListingStore.ts'
import { stored } from '../SignIn/Stored.ts'
import { cursors, nextCursor, type PageRequest, pageOf, rowsFor } from './Pages.ts'

const listingOf = ({ version, ...listing }: ListingRow): Listing => listing

/** A search's cursor: the id of the last listing on the page; the next page holds older ones. */
const after = cursors(Schema.Struct({ id: ListingId }))

// LIKE escapes with `!`, so a search for `%`, `_` or `!` matches only those characters.
const patternOf = (text: string | undefined) =>
  text === undefined ? null : `%${text.replaceAll(/[!%_]/g, (character) => `!${character}`)}%`

type ListingPage = { readonly items: ReadonlyArray<Listing>; readonly next: Cursor | null }

/** The page in `rows`, read with one row more than `limit`, and the cursor of the next. */
const pageFrom = (rows: ReadonlyArray<typeof StoredListing.Type>, limit: number | undefined) =>
  Effect.gen(function* () {
    const { items, last } = pageOf(rows.map(listingRowOf), limit)
    return { items: items.map(listingOf), next: yield* nextCursor(after.encode, last, ({ id }) => ({ id })) }
  })

/**
 * Reading listings from the `listings` projection: for anyone, one by id while it is published or withdrawn, or the
 * published ones whose title or a tag contains a text (letter case aside, for ASCII letters), newest first; for its
 * seller, their own, published or withdrawn, newest first. D1 not answering is `Unavailable`.
 */
export class ListingReads extends Context.Service<
  ListingReads,
  {
    readonly find: (id: ListingId) => Effect.Effect<Option.Option<Listing>, Unavailable>
    readonly search: (
      query: PageRequest & { readonly text?: string | undefined },
    ) => Effect.Effect<ListingPage, BadCursor | Unavailable>
    readonly owned: (owner: AccountId, request: PageRequest) => Effect.Effect<ListingPage, BadCursor | Unavailable>
  }
>()('Sidequest/ListingReads') {
  static readonly layer = Layer.effect(
    ListingReads,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const one = SqlSchema.findOneOption({
        Request: ListingId,
        Result: StoredListing,
        execute: (id) =>
          sql`SELECT ${sql.literal(listingColumns)} FROM listings WHERE id = ${id} AND state IS NOT NULL`,
      })
      const matching = SqlSchema.findAll({
        Request: Schema.Struct({
          pattern: Schema.NullOr(Schema.String),
          after: Schema.NullOr(ListingId),
          rows: Schema.Int,
        }),
        Result: StoredListing,
        execute: ({ pattern, after: last, rows }) => sql`
          SELECT ${sql.literal(listingColumns)} FROM listings
          WHERE state = 'published'
            AND (${pattern} IS NULL OR title LIKE ${pattern} ESCAPE '!'
              OR EXISTS (SELECT 1 FROM json_each(listings.tags) WHERE json_each.value LIKE ${pattern} ESCAPE '!'))
            AND (${last} IS NULL OR id < ${last})
          ORDER BY id DESC LIMIT ${rows}`,
      })
      const ownedBy = SqlSchema.findAll({
        Request: Schema.Struct({ owner: AccountId, after: Schema.NullOr(ListingId), rows: Schema.Int }),
        Result: StoredListing,
        execute: ({ owner, after: last, rows }) => sql`
          SELECT ${sql.literal(listingColumns)} FROM listings
          WHERE owner = ${owner} AND state IS NOT NULL AND (${last} IS NULL OR id < ${last})
          ORDER BY id DESC LIMIT ${rows}`,
      })
      return ListingReads.of({
        find: Effect.fn('Sidequest.ListingReads.find')(function* (id) {
          const found = yield* stored(one(id))
          return Option.map(found, (row) => listingOf(listingRowOf(row)))
        }),
        search: Effect.fn('Sidequest.ListingReads.search')(function* ({ text, limit, cursor }) {
          const start = yield* after.decode(cursor)
          const rows = yield* stored(
            matching({ pattern: patternOf(text), after: start?.id ?? null, rows: rowsFor(limit) }),
          )
          return yield* pageFrom(rows, limit)
        }),
        owned: Effect.fn('Sidequest.ListingReads.owned')(function* (owner, { limit, cursor }) {
          const start = yield* after.decode(cursor)
          const rows = yield* stored(ownedBy({ owner, after: start?.id ?? null, rows: rowsFor(limit) }))
          return yield* pageFrom(rows, limit)
        }),
      })
    }),
  )
}
