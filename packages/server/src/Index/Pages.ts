import { BadCursor, Cursor, defaultPageSize } from '@sidequest/protocol'
import { Effect, Schema } from 'effect'

/** What a paged read asks for: how many items, and the cursor it starts after (none: from the first). */
export interface PageRequest {
  readonly limit?: number | undefined
  readonly cursor?: Cursor | undefined
}

/** How many rows to read for a page of `limit`: one more, to learn whether another page follows. */
export const rowsFor = (limit: number | undefined) => (limit ?? defaultPageSize) + 1

/** The page in `rows` (read with {@link rowsFor}), and the last item on it when another page follows. */
export const pageOf = <Row>(rows: ReadonlyArray<Row>, limit: number | undefined) => {
  const items = rows.slice(0, limit ?? defaultPageSize)
  return { items, last: rows.length > items.length ? items.at(-1) : undefined }
}

/**
 * Cursors over one list: a position in it (what its order is keyed by) as base64url JSON, which a reader treats as
 * opaque. A cursor that does not decode to a position of this list is a `BadCursor`.
 */
export const cursors = <A, I>(position: Schema.Codec<A, I>) => {
  const codec = Schema.StringFromBase64Url.pipe(Schema.decodeTo(Schema.fromJsonString(position)))
  return {
    // A position the server read from its own rows always encodes.
    encode: (value: A) =>
      Schema.encodeEffect(codec)(value).pipe(
        Effect.map((encoded) => Cursor.make(encoded)),
        Effect.orDie,
      ),
    decode: (cursor: Cursor | undefined) =>
      cursor === undefined
        ? Effect.succeed(undefined)
        : Schema.decodeEffect(codec)(cursor).pipe(Effect.mapError(() => new BadCursor())),
  }
}

/** The cursor of the page after `last`, or `null` when there is none. */
export const nextCursor = <A, Row>(
  encode: (position: A) => Effect.Effect<Cursor>,
  last: Row | undefined,
  positionOf: (row: Row) => A,
) => (last === undefined ? Effect.succeed(null) : encode(positionOf(last)))
