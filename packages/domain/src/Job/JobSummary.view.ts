import * as Domain from '@alchemy.run/domain'
import { WorkRequest } from '@sidequest/protocol'
import { Effect, Schema } from 'effect'
import { asViewer, viewerRejections } from '../Authority.ts'
import { Session } from '../Session.middleware.ts'
import { Job } from './Job.aggregate.ts'
import { stageChanges } from './StageChanges.ts'
import { JobStage } from './WrongState.rejection.ts'

/**
 * What anyone signed in sees of a job: the request and its stage. No proposals, parties or money: those are the
 * buyer's ({@link BuyerJobSummary}) and each bidder's ({@link BidderJobSummary}).
 */
export class JobSummary extends Domain.View('JobSummary', {
  from: [Job],
  key: Job,
  middleware: [Session],
  rejects: [...viewerRejections],
  state: Schema.Struct({ request: Schema.NullOr(WorkRequest), state: JobStage }),
  initial: { request: null, state: 'Unposted' },
  evolve: {
    RequestPosted: (_, { request }) => ({ request, state: 'Open' as const }),
    ...stageChanges,
  },
  validate: Effect.fn(function* () {
    yield* asViewer()
  }),
}) {}
