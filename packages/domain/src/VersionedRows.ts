import { Schema } from 'effect'

/** The source stream's sequence number of the event a row last took. */
export const RowVersion = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }))

/**
 * Rows by id for a memory store, each changed only by a newer version than it holds, so a projection's redelivered or
 * replayed change is ignored. A removed row keeps its version, so an older change cannot bring it back.
 */
export const versionedRows = <Row>() => {
  const rows = new Map<string, { readonly version: number; readonly row: Row | undefined }>()
  return {
    change: (id: string, version: number, next: (row: Row | undefined) => Row | undefined) => {
      const held = rows.get(id)
      if (held === undefined || held.version < version) rows.set(id, { version, row: next(held?.row) })
    },
    get: (id: string) => rows.get(id)?.row,
    all: () => [...rows.values()].flatMap(({ row }) => (row === undefined ? [] : [row])),
  }
}
