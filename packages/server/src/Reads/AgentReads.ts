import { AccountId, type Agent, AgentId, type BadCursor, type Cursor, type Unavailable } from '@sidequest/protocol'
import { Context, Effect, Layer, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'
import { agentColumns, agentRowOf, StoredAgent } from '../Projections/D1AgentStore.ts'
import { stored } from '../SignIn/Stored.ts'
import { cursors, nextCursor, type PageRequest, pageOf, rowsFor } from './Pages.ts'

/** A page's cursor: the id of the last agent on it. */
const after = cursors(Schema.Struct({ id: AgentId }))

/** An agent as its operator reads it; an agent with no grant yet has none. */
const agentOf = Effect.fnUntraced(function* (row: typeof StoredAgent.Type) {
  const { version, grant, ...agent } = yield* agentRowOf(row).pipe(Effect.orDie)
  const read: Agent = grant === null ? agent : { ...agent, grant }
  return read
})

/** Reading an operator's agents from the `agents` projection, by id. D1 not answering is `Unavailable`. */
export class AgentReads extends Context.Service<
  AgentReads,
  {
    readonly page: (
      operator: AccountId,
      request: PageRequest,
    ) => Effect.Effect<{ readonly items: ReadonlyArray<Agent>; readonly next: Cursor | null }, BadCursor | Unavailable>
  }
>()('Sidequest/AgentReads') {
  static readonly layer = Layer.effect(
    AgentReads,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const operated = SqlSchema.findAll({
        Request: Schema.Struct({ operator: AccountId, after: Schema.NullOr(AgentId), rows: Schema.Int }),
        Result: StoredAgent,
        execute: ({ operator, after: last, rows }) => sql`
          SELECT ${sql.literal(agentColumns)} FROM agents
          WHERE operator = ${operator} AND (${last} IS NULL OR id > ${last})
          ORDER BY id LIMIT ${rows}`,
      })
      return AgentReads.of({
        page: Effect.fn('Sidequest.AgentReads.page')(function* (operator, { limit, cursor }) {
          const start = yield* after.decode(cursor)
          const rows = yield* stored(operated({ operator, after: start?.id ?? null, rows: rowsFor(limit) }))
          const { items, last } = pageOf(rows, limit)
          return {
            items: yield* Effect.forEach(items, agentOf),
            next: yield* nextCursor(after.encode, last, ({ id }) => ({ id })),
          }
        }),
      })
    }),
  )
}
