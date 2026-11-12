import { Schema } from 'effect'

/** The most items one page holds. */
export const maxPageSize = 50

/** How many items a page holds when the reader does not say. */
export const defaultPageSize = 20

/** How many items a reader asks for, in the query string: a whole number from 1 to {@link maxPageSize}. */
export const PageSize = Schema.FiniteFromString.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: maxPageSize }),
)

/**
 * Where the next page starts. It is opaque: a reader passes back the one the server gave it, and never builds or
 * reads one, so the server may change what it encodes.
 */
export const Cursor = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,256}$/u)).pipe(Schema.brand('Cursor'))
export type Cursor = typeof Cursor.Type

/** The query of a paged read: how many items, and the cursor of the page to start from (none: the first). */
export const PageQuery = { limit: Schema.optional(PageSize), cursor: Schema.optional(Cursor) }

/** One page of a list in a stable order, with the cursor of the next page, `null` after the last. */
export const Page = <Item extends Schema.Top>(item: Item) =>
  Schema.Struct({ items: Schema.Array(item), next: Schema.NullOr(Cursor) })
