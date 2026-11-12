import * as Domain from '@alchemy.run/domain'
import { Effect, Predicate } from 'effect'
import { ProposalAccepted } from './AcceptProposal.command.ts'
import { RequestCancelled } from './CancelRequest.command.ts'
import { RequestExpired } from './ExpireRequest.command.ts'
import { Job } from './Job.aggregate.ts'
import { OpenJobStore } from './OpenJobStore.ts'
import { RequestPosted } from './PostRequest.command.ts'

/** The requests still open for proposals, through the {@link OpenJobStore} port. */
export class OpenJobs extends Domain.Projection('OpenJobs', {
  from: [Job],
  key: Job,
  on: [RequestPosted, ProposalAccepted, RequestCancelled, RequestExpired],
}) {}

export const OpenJobsLive = OpenJobs.toLayer(
  Effect.gen(function* () {
    const store = yield* OpenJobStore
    return (batch) =>
      store.apply(
        batch.map(({ key, event, envelope: { seq: version } }) => {
          if (!Predicate.isTagged(event, 'RequestPosted')) return { _tag: 'Closed' as const, id: key.id, version }
          const { id, buyer, title, expiresAt } = event.request
          return { _tag: 'Opened' as const, row: { id, buyer, title, expiresAt, version } }
        }),
      )
  }),
)
