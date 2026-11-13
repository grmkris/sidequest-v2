import {
  type BadCursor,
  type Cursor,
  defaultPageSize,
  IndexListing,
  IndexListingDetail,
  type Unavailable,
} from '@sidequest/protocol'
import { Context, Effect, Layer, Option, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'
import { cursors, nextCursor, pageOf, type PageRequest, rowsFor } from '../Reads/Pages.ts'
import { stored } from '@sidequest/serving/Stored'
import type { ListingRow } from './Derived.ts'

/**
 * Stores a listing row, replacing the seller's row under the same slug only when this event supersedes it: later, or
 * as old with a lower id (NIP-01's rule, decided in the statement), so the table is the same in any arrival order.
 */
export const putListing = (sql: SqlClient.SqlClient, row: ListingRow) => sql`
  INSERT INTO nostr_listings (pubkey, d, event_id, created_at, title, summary, description, topics, price_amount,
    price_asset, network, status, published_at)
  VALUES (${row.pubkey}, ${row.slug}, ${row.eventId}, ${row.createdAt}, ${row.title}, ${row.summary},
    ${row.description}, ${JSON.stringify(row.topics)}, ${row.price?.amount ?? null}, ${row.price?.asset ?? null},
    ${row.network}, ${row.status}, ${row.publishedAt})
  ON CONFLICT (pubkey, d) DO UPDATE SET event_id = excluded.event_id, created_at = excluded.created_at,
    title = excluded.title, summary = excluded.summary, description = excluded.description, topics = excluded.topics,
    price_amount = excluded.price_amount, price_asset = excluded.price_asset, network = excluded.network,
    status = excluded.status, published_at = excluded.published_at
  WHERE excluded.created_at > nostr_listings.created_at
    OR (excluded.created_at = nostr_listings.created_at AND excluded.event_id < nostr_listings.event_id)`

/** A search of listings: text in the title or summary, a topic, and the page. */
export interface ListingSearch extends PageRequest {
  readonly q?: string | undefined
  readonly tag?: string | undefined
}

/** Where a page of listings ends: newest first, so by `createdAt` descending, then event id. */
const Position = Schema.Struct({ createdAt: Schema.Int, event: Schema.String })
const listingCursors = cursors(Position)

const ListingRecord = Schema.Struct({
  pubkey: Schema.String,
  slug: Schema.String,
  event: Schema.String,
  createdAt: Schema.Int,
  title: Schema.String,
  summary: Schema.String,
  description: Schema.String,
  topics: Schema.fromJsonString(Schema.Array(Schema.String)),
  priceAmount: Schema.NullOr(Schema.String),
  priceAsset: Schema.NullOr(Schema.String),
  network: Schema.NullOr(Schema.String),
  status: Schema.String,
  publishedAt: Schema.Int,
  authorName: Schema.NullOr(Schema.String),
  walletVerified: Schema.Literals([0, 1]),
})
type ListingRecord = typeof ListingRecord.Type

/** `text` as a `LIKE` pattern matching it anywhere, its own wildcards escaped with `\`. */
const containing = (text: string) => `%${text.replaceAll(/[\\%_]/gu, (character) => `\\${character}`)}%`

const listingReads = (sql: SqlClient.SqlClient) => {
  // The listing's columns, its author's profile name, and whether a verified link currently holds a wallet for the
  // author: one of their verified links that no other verified link of its account beats (the identity reads' rule).
  const columns = sql`
    l.pubkey, l.d AS slug, l.event_id AS event, l.created_at AS createdAt, l.title, l.summary, l.description,
    l.topics, l.price_amount AS priceAmount, l.price_asset AS priceAsset, l.network, l.status,
    l.published_at AS publishedAt, p.name AS authorName,
    EXISTS (
      SELECT 1 FROM wallet_links AS link
      WHERE link.pubkey = l.pubkey AND link.verification = 'verified' AND NOT EXISTS (
        SELECT 1 FROM wallet_links AS rival
        WHERE rival.account = link.account AND rival.verification = 'verified'
          AND (rival.issued_at > link.issued_at
            OR (rival.issued_at = link.issued_at AND rival.event_id < link.event_id)))
    ) AS walletVerified
    FROM nostr_listings AS l LEFT JOIN profiles AS p ON p.pubkey = l.pubkey`
  const one = SqlSchema.findOneOption({
    Request: Schema.Struct({ pubkey: Schema.String, slug: Schema.String }),
    Result: ListingRecord,
    execute: ({ pubkey, slug }) => sql`SELECT ${columns} WHERE l.pubkey = ${pubkey} AND l.d = ${slug}`,
  })
  // Newest first by keyset: an index walk over `nostr_listings_newest` that stops at the page's end. The text and topic
  // filters are optional (`NULL` turns each off), so this stays one statement.
  const search = SqlSchema.findAll({
    Request: Schema.Struct({
      q: Schema.NullOr(Schema.String),
      tag: Schema.NullOr(Schema.String),
      after: Schema.NullOr(Position),
      rows: Schema.Int,
    }),
    Result: ListingRecord,
    execute: ({ q, tag, after, rows }) => sql`
      SELECT ${columns}
      WHERE (${after?.createdAt ?? null} IS NULL OR l.created_at < ${after?.createdAt ?? null}
          OR (l.created_at = ${after?.createdAt ?? null} AND l.event_id > ${after?.event ?? null}))
        AND (${q} IS NULL OR l.title LIKE ${q === null ? null : containing(q)} ESCAPE '\\'
          OR l.summary LIKE ${q === null ? null : containing(q)} ESCAPE '\\')
        AND (${tag} IS NULL OR EXISTS (SELECT 1 FROM json_each(l.topics) WHERE json_each.value = ${tag}))
      ORDER BY l.created_at DESC, l.event_id
      LIMIT ${rows}`,
  })
  return { one, search }
}

const listingOf = (record: ListingRecord) => ({
  pubkey: record.pubkey,
  slug: record.slug,
  event: record.event,
  createdAt: record.createdAt,
  title: record.title,
  summary: record.summary,
  topics: record.topics,
  price:
    record.priceAmount === null || record.priceAsset === null
      ? null
      : { amount: record.priceAmount, asset: record.priceAsset },
  network: record.network,
  status: record.status,
  publishedAt: record.publishedAt,
  author: { name: record.authorName, walletVerified: record.walletVerified === 1 },
})

// Rows were written from listings `@sidequest/nostr` read, so they always decode; one that would not is left out.
const asListing = Schema.decodeUnknownOption(IndexListing)
const asDetail = Schema.decodeUnknownOption(IndexListingDetail)

/** The index's listings: search newest first, and one by its seller and slug. */
export class Listings extends Context.Service<
  Listings,
  {
    readonly search: (
      query: ListingSearch,
    ) => Effect.Effect<
      { readonly items: ReadonlyArray<IndexListing>; readonly next: Cursor | null },
      BadCursor | Unavailable
    >
    readonly get: (pubkey: string, slug: string) => Effect.Effect<Option.Option<IndexListingDetail>, Unavailable>
  }
>()('Sidequest/Index/Listings') {
  /** Over the D1 tables; needs the database's `SqlClient`. */
  static readonly layer = Layer.effect(
    Listings,
    Effect.gen(function* () {
      const read = listingReads(yield* SqlClient.SqlClient)
      return Listings.of({
        search: Effect.fn('Sidequest.Index.listings')(function* (query) {
          const after = yield* listingCursors.decode(query.cursor)
          const rows = yield* stored(
            read.search({
              q: query.q ?? null,
              tag: query.tag ?? null,
              after: after ?? null,
              rows: rowsFor(query.limit),
            }),
          )
          const { items, last } = pageOf(rows, query.limit ?? defaultPageSize)
          const next = yield* nextCursor(listingCursors.encode, last, (row) => ({
            createdAt: row.createdAt,
            event: row.event,
          }))
          return { items: items.flatMap((row) => Option.toArray(asListing(listingOf(row)))), next }
        }),
        get: Effect.fn('Sidequest.Index.listing')(function* (pubkey, slug) {
          const found = yield* stored(read.one({ pubkey, slug }))
          return Option.flatMap(found, (row) => asDetail({ ...listingOf(row), description: row.description }))
        }),
      })
    }),
  )
}
