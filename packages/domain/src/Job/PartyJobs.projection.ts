import * as Domain from '@alchemy.run/domain'
import type { JobState } from '@sidequest/protocol'
import { Effect, Match } from 'effect'
import { ProposalAccepted } from './AcceptProposal.command.ts'
import { RequestCancelled } from './CancelRequest.command.ts'
import { RequestExpired } from './ExpireRequest.command.ts'
import { Job } from './Job.aggregate.ts'
import { PartyJobStore } from './PartyJobStore.ts'
import { RequestPosted } from './PostRequest.command.ts'
import { DeliveryRecorded } from './RecordDelivery.command.ts'
import { FundingRecorded } from './RecordFunding.command.ts'
import { RejectionRecorded } from './RecordRejection.command.ts'
import { JobSettled } from './RecordSettlement.command.ts'
import { ProposalSubmitted } from './SubmitProposal.command.ts'

/**
 * Every account's jobs, through {@link PartyJobStore}: the requests it posted and the ones it bid on, each with its
 * stage, so a person can list their jobs as buyer and as bidder or worker.
 */
export class PartyJobs extends Domain.Projection('PartyJobs', {
  from: [Job],
  key: Job,
  on: [
    RequestPosted,
    ProposalSubmitted,
    ProposalAccepted,
    RequestCancelled,
    RequestExpired,
    FundingRecorded,
    DeliveryRecorded,
    RejectionRecorded,
    JobSettled,
  ],
}) {}

export const PartyJobsLive = PartyJobs.toLayer(
  Effect.gen(function* () {
    const store = yield* PartyJobStore
    return (batch) =>
      store.apply(
        batch.map(({ key, event, envelope: { seq: version } }) => {
          const moved = (state: JobState) => ({ _tag: 'Moved' as const, id: key.id, state, version })
          return Match.valueTags(event, {
            RequestPosted: ({ request: { id, buyer, title, expiresAt } }) => ({
              _tag: 'Posted' as const,
              id,
              buyer,
              title,
              expiresAt,
              version,
            }),
            ProposalSubmitted: ({ proposal }) => ({ _tag: 'Bid' as const, id: key.id, bidder: proposal.bidder }),
            ProposalAccepted: ({ agreement }) => ({
              _tag: 'Awarded' as const,
              id: key.id,
              worker: agreement.worker,
              version,
            }),
            RequestCancelled: () => moved('Cancelled'),
            RequestExpired: () => moved('Expired'),
            FundingRecorded: () => moved('Funded'),
            DeliveryRecorded: () => moved('Delivered'),
            RejectionRecorded: () => moved('Disputed'),
            JobSettled: () => moved('Settled'),
          })
        }),
      )
  }),
)
