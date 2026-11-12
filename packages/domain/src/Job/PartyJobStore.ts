import { AccountId, JobId, JobState, OpenRequest, PartyJob } from '@sidequest/protocol'
import { Context, Effect, Layer, Match, Schema } from 'effect'
import { RowVersion, versionedRows } from '../VersionedRows.ts'

/** One change to the jobs list of the accounts taking part: at the job stream's version where it moves the job. */
export const PartyJobChange = Schema.Union([
  Schema.TaggedStruct('Posted', { ...OpenRequest.fields, version: RowVersion }),
  Schema.TaggedStruct('Bid', { id: JobId, bidder: AccountId }),
  Schema.TaggedStruct('Awarded', { id: JobId, worker: AccountId, version: RowVersion }),
  Schema.TaggedStruct('Moved', { id: JobId, state: JobState, version: RowVersion }),
])
export type PartyJobChange = typeof PartyJobChange.Type

/**
 * The port the `PartyJobs` projection writes through: each job's request and stage, and who takes part in it. A
 * stage change applies only when its version is newer than the job's, a bid is recorded once, and an award makes the
 * bidder the worker, so redelivered changes are harmless. The server implements it with D1.
 */
export class PartyJobStore extends Context.Service<
  PartyJobStore,
  {
    readonly apply: (changes: ReadonlyArray<PartyJobChange>) => Effect.Effect<void>
    readonly list: (account: AccountId) => Effect.Effect<ReadonlyArray<PartyJob>>
  }
>()('Sidequest/PartyJobStore') {}

type Request = Omit<PartyJob, 'role'> & { readonly version: number }

/** A party-job store in memory, for stories. */
export const memoryPartyJobStore = () => {
  const jobs = versionedRows<Request>()
  const roles = new Map<string, Map<AccountId, PartyJob['role']>>()
  const take = (job: JobId, account: AccountId, role: PartyJob['role']) => {
    const parties = roles.get(job) ?? new Map<AccountId, PartyJob['role']>()
    if (!parties.has(account) || role === 'worker') parties.set(account, role)
    roles.set(job, parties)
  }
  return PartyJobStore.of({
    apply: (changes) =>
      Effect.sync(() => {
        for (const change of changes)
          Match.valueTags(change, {
            Posted: ({ _tag, version, ...request }) => {
              jobs.change(request.id, version, () => ({ ...request, state: 'Open', version }))
              take(request.id, request.buyer, 'buyer')
            },
            Bid: ({ id, bidder }) => take(id, bidder, 'bidder'),
            Awarded: ({ id, worker, version }) => {
              jobs.change(id, version, (row) => (row === undefined ? row : { ...row, state: 'Awarded', version }))
              take(id, worker, 'worker')
            },
            Moved: ({ id, state, version }) =>
              jobs.change(id, version, (row) => (row === undefined ? row : { ...row, state, version })),
          })
      }),
    list: (account) =>
      Effect.sync(() =>
        jobs.all().flatMap(({ version, ...job }) => {
          const role = roles.get(job.id)?.get(account)
          return role === undefined ? [] : [{ ...job, role }]
        }),
      ),
  })
}

export const MemoryPartyJobStore = Layer.sync(PartyJobStore, memoryPartyJobStore)
