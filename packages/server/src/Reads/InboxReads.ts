import { InboxItem } from '@sidequest/domain/Inbox/InboxStore'
import { AccountId, type BadCursor, type Cursor, type InboxEntry, type Unavailable } from '@sidequest/protocol'
import { Context, Effect, Layer, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'
import { stored } from '@sidequest/serving/Stored'
import { cursors, nextCursor, type PageRequest, pageOf, rowsFor } from './Pages.ts'

const Position = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** An inbox cursor: the per-account position of the last item read, 0 before the first. */
const after = cursors(Schema.Struct({ position: Position }))

/** A cursor back through the inbox: the position of the oldest item on the page read, whose older items come next. */
const before = cursors(Schema.Struct({ before: Position }))

const entryOf = ({ account, cursor, ...entry }: InboxItem): InboxEntry => entry

/**
 * Reading one account's inbox from the `inbox_items` projection. `page` goes in the order items reached it, and the
 * cursor it answers with is always where the next read starts, so a reader that saw everything polls with it. `recent`
 * goes the other way, from the newest item back, and answers the cursor to poll `page` with from the newest item. D1
 * not answering is `Unavailable`.
 */
export class InboxReads extends Context.Service<
  InboxReads,
  {
    readonly page: (
      account: AccountId,
      request: PageRequest,
    ) => Effect.Effect<
      { readonly items: ReadonlyArray<InboxEntry>; readonly next: Cursor; readonly more: boolean },
      BadCursor | Unavailable
    >
    readonly recent: (
      account: AccountId,
      request: PageRequest,
    ) => Effect.Effect<
      { readonly items: ReadonlyArray<InboxEntry>; readonly next: Cursor | null; readonly latest: Cursor },
      BadCursor | Unavailable
    >
  }
>()('Sidequest/InboxReads') {
  static readonly layer = Layer.effect(
    InboxReads,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const itemsAfter = SqlSchema.findAll({
        Request: Schema.Struct({ account: AccountId, position: Schema.Int, rows: Schema.Int }),
        Result: InboxItem,
        execute: ({ account, position, rows }) => sql`
          SELECT account, cursor, id, kind, job, room, at FROM inbox_items
          WHERE account = ${account} AND cursor > ${position} ORDER BY cursor LIMIT ${rows}`,
      })
      const newest = SqlSchema.findOne({
        Request: AccountId,
        Result: Schema.Struct({ position: Position }),
        execute: (account) =>
          sql`SELECT COALESCE(MAX(cursor), 0) AS position FROM inbox_items WHERE account = ${account}`,
      })
      const itemsBefore = SqlSchema.findAll({
        Request: Schema.Struct({ account: AccountId, position: Schema.Int, rows: Schema.Int }),
        Result: InboxItem,
        execute: ({ account, position, rows }) => sql`
          SELECT account, cursor, id, kind, job, room, at FROM inbox_items
          WHERE account = ${account} AND cursor < ${position} ORDER BY cursor DESC LIMIT ${rows}`,
      })
      return InboxReads.of({
        page: Effect.fn('Sidequest.InboxReads.page')(function* (account, { limit, cursor }) {
          const position = (yield* after.decode(cursor))?.position ?? 0
          const rows = yield* stored(itemsAfter({ account, position, rows: rowsFor(limit) }))
          const { items, last } = pageOf(rows, limit)
          const reached = items.at(-1)?.cursor ?? position
          return {
            items: items.map(entryOf),
            next: yield* after.encode({ position: reached }),
            more: last !== undefined,
          }
        }),
        recent: Effect.fn('Sidequest.InboxReads.recent')(function* (account, { limit, cursor }) {
          const start = yield* before.decode(cursor)
          // An aggregate over no rows is still one row, so `findOne` always finds it.
          const { position: latest } = yield* stored(
            newest(account).pipe(Effect.catchTag('NoSuchElementError', (error) => Effect.die(error))),
          )
          const rows = yield* stored(
            itemsBefore({ account, position: start?.before ?? latest + 1, rows: rowsFor(limit) }),
          )
          const { items, last } = pageOf(rows, limit)
          return {
            items: items.map(entryOf),
            next: yield* nextCursor(before.encode, last, ({ cursor: position }) => ({ before: position })),
            latest: yield* after.encode({ position: latest }),
          }
        }),
      })
    }),
  )
}
