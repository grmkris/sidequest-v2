import { type PartyJobChange, PartyJobStore } from '@sidequest/domain/Job/PartyJobStore'
import { AccountId, PartyJob } from '@sidequest/protocol'
import { Effect, Layer, Match } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

/** The columns a {@link PartyJob} reads from `party_jobs` joined with `job_parties`. */
export const partyJobColumns =
  'party_jobs.id AS id, buyer, title, expires_at AS expiresAt, state, job_parties.role AS role'

/**
 * The `party_jobs` and `job_parties` tables behind the `PartyJobs` projection. A stage change writes only when its
 * version is newer than the job's; a bid is inserted once and never demotes the worker; an award makes the bidder the
 * worker. Every change is one statement, so a redelivered one does nothing. D1 failing is a defect: the projection's
 * delivery is retried.
 */
export const D1PartyJobStore = Layer.effect(
  PartyJobStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const party = (account: AccountId, job: string, role: PartyJob['role']) => sql`
      INSERT INTO job_parties (account, job, role) VALUES (${account}, ${job}, ${role})
      ON CONFLICT (account, job) DO UPDATE SET role = excluded.role
      WHERE excluded.role = 'worker'`
    const stage = (id: string, state: PartyJob['state'], version: number) => sql`
      INSERT INTO party_jobs (id, version) VALUES (${id}, ${version})
      ON CONFLICT (id) DO UPDATE SET
        state = CASE WHEN party_jobs.state IS NULL THEN NULL ELSE ${state} END, version = excluded.version
      WHERE excluded.version > party_jobs.version`
    const write = (change: PartyJobChange) =>
      Match.valueTags(change, {
        Posted: ({ id, buyer, title, expiresAt, version }) =>
          sql`
            INSERT INTO party_jobs (id, buyer, title, expires_at, state, version)
            VALUES (${id}, ${buyer}, ${title}, ${expiresAt}, 'Open', ${version})
            ON CONFLICT (id) DO UPDATE SET
              buyer = excluded.buyer, title = excluded.title, expires_at = excluded.expires_at,
              state = excluded.state, version = excluded.version
            WHERE excluded.version > party_jobs.version`.pipe(Effect.andThen(party(buyer, id, 'buyer'))),
        Bid: ({ id, bidder }) => party(bidder, id, 'bidder'),
        Awarded: ({ id, worker, version }) =>
          stage(id, 'Awarded', version).pipe(Effect.andThen(party(worker, id, 'worker'))),
        Moved: ({ id, state, version }) => stage(id, state, version),
      })
    const list = SqlSchema.findAll({
      Request: AccountId,
      Result: PartyJob,
      execute: (account) => sql`
        SELECT ${sql.literal(partyJobColumns)} FROM job_parties JOIN party_jobs ON party_jobs.id = job_parties.job
        WHERE job_parties.account = ${account} AND party_jobs.state IS NOT NULL ORDER BY party_jobs.id DESC`,
    })
    return PartyJobStore.of({
      apply: Effect.fn('Sidequest.PartyJobs.apply')(function* (changes) {
        yield* Effect.forEach(changes, write, { discard: true }).pipe(Effect.orDie)
      }),
      list: Effect.fn('Sidequest.PartyJobs.list')(function* (account) {
        return yield* list(account).pipe(Effect.orDie)
      }),
    })
  }),
)
