import {
  AccountId,
  type BadCursor,
  type Cursor,
  JobId,
  type JobSide,
  PartyJob,
  type Unavailable,
} from '@sidequest/protocol'
import { Context, Effect, Layer, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'
import { partyJobColumns } from '../Projections/D1PartyJobStore.ts'
import { stored } from '../SignIn/Stored.ts'
import { cursors, nextCursor, type PageRequest, pageOf, rowsFor } from './Pages.ts'

/** A page's cursor: the id of the last job on it; the next page holds older ones. */
const after = cursors(Schema.Struct({ id: JobId }))

/**
 * Reading one account's jobs from the `PartyJobs` projection, newest first: those it posted as buyer, or those it bid
 * on, whether it won them or not. D1 not answering is `Unavailable`.
 */
export class PartyJobReads extends Context.Service<
  PartyJobReads,
  {
    readonly page: (
      account: AccountId,
      side: JobSide,
      request: PageRequest,
    ) => Effect.Effect<
      { readonly items: ReadonlyArray<PartyJob>; readonly next: Cursor | null },
      BadCursor | Unavailable
    >
  }
>()('Sidequest/PartyJobReads') {
  static readonly layer = Layer.effect(
    PartyJobReads,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const jobsOf = SqlSchema.findAll({
        Request: Schema.Struct({
          account: AccountId,
          buyer: Schema.Boolean,
          after: Schema.NullOr(JobId),
          rows: Schema.Int,
        }),
        Result: PartyJob,
        execute: ({ account, buyer, after: last, rows }) => sql`
          SELECT ${sql.literal(partyJobColumns)} FROM job_parties JOIN party_jobs ON party_jobs.id = job_parties.job
          WHERE job_parties.account = ${account}
            AND (${buyer ? 1 : 0} = 1 AND job_parties.role = 'buyer'
              OR ${buyer ? 1 : 0} = 0 AND job_parties.role IN ('bidder', 'worker'))
            AND party_jobs.state IS NOT NULL
            AND (${last} IS NULL OR job_parties.job < ${last})
          ORDER BY job_parties.job DESC LIMIT ${rows}`,
      })
      return PartyJobReads.of({
        page: Effect.fn('Sidequest.PartyJobReads.page')(function* (account, side, { limit, cursor }) {
          const start = yield* after.decode(cursor)
          const rows = yield* stored(
            jobsOf({ account, buyer: side === 'buyer', after: start?.id ?? null, rows: rowsFor(limit) }),
          )
          const { items, last } = pageOf(rows, limit)
          return { items, next: yield* nextCursor(after.encode, last, ({ id }) => ({ id })) }
        }),
      })
    }),
  )
}
