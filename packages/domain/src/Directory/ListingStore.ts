import { AccountId, Listing, ListingDetails, ListingId } from '@sidequest/protocol'
import { Context, Effect, Layer, Match, Option, Schema } from 'effect'
import { RowVersion, versionedRows } from '../VersionedRows.ts'

/** A listing as search and readers see it. `version` is the listing stream's sequence number it reflects. */
export const ListingRow = Schema.Struct({ ...Listing.fields, version: RowVersion })
export type ListingRow = typeof ListingRow.Type

/** One change to a listing row, at the listing's version. */
export const ListingChange = Schema.Union([
  Schema.TaggedStruct('Published', { id: ListingId, owner: AccountId, ...ListingDetails.fields, version: RowVersion }),
  Schema.TaggedStruct('Updated', { id: ListingId, ...ListingDetails.fields, version: RowVersion }),
  Schema.TaggedStruct('Withdrawn', { id: ListingId, version: RowVersion }),
])
export type ListingChange = typeof ListingChange.Type

/**
 * The port the `Listings` projection writes search rows through. `apply` must ignore a change whose version is not
 * newer than the row's, so redelivered changes are harmless. The server implements it with D1.
 */
export class ListingStore extends Context.Service<
  ListingStore,
  {
    readonly apply: (changes: ReadonlyArray<ListingChange>) => Effect.Effect<void>
    readonly get: (id: ListingId) => Effect.Effect<Option.Option<ListingRow>>
  }
>()('Sidequest/ListingStore') {}

/** A listing store in memory, for stories. */
export const memoryListingStore = () => {
  const rows = versionedRows<ListingRow>()
  return ListingStore.of({
    apply: (changes) =>
      Effect.sync(() => {
        for (const change of changes)
          rows.change(change.id, change.version, (row) =>
            Match.valueTags(change, {
              Published: ({ _tag, ...published }) => ({ ...published, state: 'published' as const }),
              Updated: ({ _tag, id, ...details }) =>
                row === undefined ? row : { id, owner: row.owner, ...details, state: row.state },
              Withdrawn: ({ version }) => (row === undefined ? row : { ...row, state: 'withdrawn' as const, version }),
            }),
          )
      }),
    get: (id) => Effect.sync(() => Option.fromUndefinedOr(rows.get(id))),
  })
}

export const MemoryListingStore = Layer.sync(ListingStore, memoryListingStore)
