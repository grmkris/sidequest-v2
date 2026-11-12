import { InboxItem } from '@sidequest/domain/Inbox/InboxStore'
import { AccountId, type BadCursor, type Cursor, type InboxEntry, type Unavailable } from '@sidequest/protocol'
import { Context, Effect, Layer, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'
import { stored } from '../SignIn/Stored.ts'
import { cursors, type PageRequest, pageOf, rowsFor } from './Pages.ts'

/** An inbox cursor: the per-account position of the last item read, 0 before the first. */
const after = cursors(Schema.Struct({ position: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) }))

const entryOf = ({ account, cursor, ...entry }: InboxItem): InboxEntry => entry

/**
 * Reading one account's inbox from the `inbox_items` projection, in the order items reached it. The cursor it
 * answers with is always where the next read starts, so a reader that saw everything polls with it. D1 not answering
 * is `Unavailable`.
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
      })
    }),
  )
}
