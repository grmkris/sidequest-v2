import { InboxItem, InboxStore } from '@sidequest/domain/Inbox/InboxStore'
import { AccountId } from '@sidequest/protocol'
import { Effect, Layer, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

/**
 * The `inbox_items` table behind the `Inbox` projection, keyed by account and item id (the source event's
 * `stream:seq`): a redelivered item overwrites itself. D1 failing is a defect: the projection's delivery is retried.
 */
export const D1InboxStore = Layer.effect(
  InboxStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const write = ({ account, id, cursor, kind, job, room, at }: InboxItem) => sql`
      INSERT INTO inbox_items (account, id, cursor, kind, job, room, at)
      VALUES (${account}, ${id}, ${cursor}, ${kind}, ${job}, ${room}, ${at})
      ON CONFLICT (account, id) DO UPDATE SET
        cursor = excluded.cursor, kind = excluded.kind, job = excluded.job, room = excluded.room, at = excluded.at`
    const itemsAfter = SqlSchema.findAll({
      Request: Schema.Struct({ account: AccountId, cursor: Schema.Int }),
      Result: InboxItem,
      execute: ({ account, cursor }) => sql`
        SELECT account, cursor, id, kind, job, room, at FROM inbox_items
        WHERE account = ${account} AND cursor > ${cursor} ORDER BY cursor`,
    })
    return InboxStore.of({
      record: Effect.fn('Sidequest.Inbox.record')(function* (items) {
        yield* Effect.forEach(items, write, { discard: true }).pipe(Effect.orDie)
      }),
      list: Effect.fn('Sidequest.Inbox.list')(function* (account, after) {
        return yield* itemsAfter({ account, cursor: after }).pipe(Effect.orDie)
      }),
    })
  }),
)
