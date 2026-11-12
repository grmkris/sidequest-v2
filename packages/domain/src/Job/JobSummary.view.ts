import * as Domain from '@alchemy.run/domain'
import { PublicJobView } from '@sidequest/protocol'
import { Job } from './Job.aggregate.ts'
import { stageChanges } from './StageChanges.ts'

/**
 * What anyone sees of a job, signed in or not: the request and its stage. No proposals, parties or money: those are
 * the buyer's ({@link BuyerJobSummary}) and each bidder's ({@link BidderJobSummary}). A posted request is public, as
 * the list of open requests is, so this view needs no session and judges no reader.
 */
export class JobSummary extends Domain.View('JobSummary', {
  from: [Job],
  key: Job,
  state: PublicJobView,
  initial: { request: null, state: 'Unposted' },
  evolve: {
    RequestPosted: (_, { request }) => ({ request, state: 'Open' as const }),
    ...stageChanges,
  },
}) {}
