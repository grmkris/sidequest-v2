import { OpenJobStore, OpenJobRow, type OpenJobChange } from '@sidequest/domain/Job/OpenJobStore'
import { Effect, Layer, Match, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

/**
 * The `open_jobs` table behind the `OpenJobs` projection. A closed job keeps a row with its version and `open = 0`,
 * so an older change can never reopen it, whichever order changes arrive in; each change is one statement that
 * writes only when its version is newer than the row's. D1 failing is a defect: the projection's delivery is retried.
 */
export const D1OpenJobStore = Layer.effect(
  OpenJobStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const write = (change: OpenJobChange) =>
      Match.valueTags(change, {
        Opened: ({ row: { id, buyer, title, expiresAt, version } }) => sql`
          INSERT INTO open_jobs (id, buyer, title, expires_at, open, version)
          VALUES (${id}, ${buyer}, ${title}, ${expiresAt}, 1, ${version})
          ON CONFLICT (id) DO UPDATE SET
            buyer = excluded.buyer, title = excluded.title, expires_at = excluded.expires_at, open = 1,
            version = excluded.version
          WHERE excluded.version > open_jobs.version`,
        Closed: ({ id, version }) => sql`
          INSERT INTO open_jobs (id, open, version) VALUES (${id}, 0, ${version})
          ON CONFLICT (id) DO UPDATE SET open = 0, version = excluded.version
          WHERE excluded.version > open_jobs.version`,
      })
    const list = SqlSchema.findAll({
      Request: Schema.Void,
      Result: OpenJobRow,
      execute: () =>
        sql`SELECT id, buyer, title, expires_at AS expiresAt, version FROM open_jobs WHERE open = 1 ORDER BY expires_at, id`,
    })
    return OpenJobStore.of({
      apply: Effect.fn('Sidequest.OpenJobs.apply')(function* (changes) {
        yield* Effect.forEach(changes, write, { discard: true }).pipe(Effect.orDie)
      }),
      list: list(undefined).pipe(Effect.orDie, Effect.withSpan('Sidequest.OpenJobs.list')),
    })
  }),
)
