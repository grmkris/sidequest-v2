import { type BadCursor, type Cursor, JobId, OpenRequest, type Unavailable, UnixSeconds } from '@sidequest/protocol'
import { Context, Effect, Layer, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'
import { stored } from '../SignIn/Stored.ts'
import { cursors, nextCursor, type PageRequest, pageOf, rowsFor } from './Pages.ts'

/** A page's cursor: the expiry and id of the last request on it, the order the list is in. */
const after = cursors(Schema.Struct({ expiresAt: UnixSeconds, id: JobId }))

/**
 * Reading the requests open for proposals from the `open_jobs` projection, for anyone: soonest to expire first, then
 * by id. D1 not answering is `Unavailable`.
 */
export class OpenRequestReads extends Context.Service<
  OpenRequestReads,
  {
    readonly page: (
      request: PageRequest,
    ) => Effect.Effect<
      { readonly items: ReadonlyArray<OpenRequest>; readonly next: Cursor | null },
      BadCursor | Unavailable
    >
  }
>()('Sidequest/OpenRequestReads') {
  static readonly layer = Layer.effect(
    OpenRequestReads,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const open = SqlSchema.findAll({
        Request: Schema.Struct({ expiresAt: Schema.NullOr(UnixSeconds), id: Schema.NullOr(JobId), rows: Schema.Int }),
        Result: OpenRequest,
        execute: ({ expiresAt, id, rows }) => sql`
          SELECT id, buyer, title, expires_at AS expiresAt FROM open_jobs
          WHERE open = 1
            AND (${expiresAt} IS NULL OR expires_at > ${expiresAt} OR (expires_at = ${expiresAt} AND id > ${id}))
          ORDER BY expires_at, id LIMIT ${rows}`,
      })
      return OpenRequestReads.of({
        page: Effect.fn('Sidequest.OpenRequestReads.page')(function* ({ limit, cursor }) {
          const start = yield* after.decode(cursor)
          const rows = yield* stored(
            open({ expiresAt: start?.expiresAt ?? null, id: start?.id ?? null, rows: rowsFor(limit) }),
          )
          const { items, last } = pageOf(rows, limit)
          return { items, next: yield* nextCursor(after.encode, last, ({ expiresAt, id }) => ({ expiresAt, id })) }
        }),
      })
    }),
  )
}
