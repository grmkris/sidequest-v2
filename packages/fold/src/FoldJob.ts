import type { EventId } from '@sidequest/nostr'
import { Option } from 'effect'
import { chainOf } from './Chain.ts'
import { compareText, eventsOf } from './Events.ts'
import { fundedProposalOf, fundingView } from './Funding.ts'
import { type FoldContext, type JobEvent, type JobInput, jobOfEvent } from './JobInput.ts'
import type { JobView, ProposalView } from './JobView.ts'
import {
  acceptViews,
  closedByBuyer,
  isAcceptedBy,
  isExpired,
  isSuperseded,
  isWithdrawn,
  signedFields,
  statementViews,
} from './Negotiation.ts'
import { deliveryNoteViews, reviewViews } from './Records.ts'
import { deadlinesOf, stageOf } from './Stage.ts'

/**
 * Folds one job: a pure function of the set of its events, the chain facts and the wallet links, so any order or
 * duplication of the same inputs gives a deeply equal view. `created_at` only orders lists. `None` when the request
 * event is not among the events: the job's id is its request's id, and without it there is no buyer to judge by.
 */
export const foldJob = (input: JobInput): Option.Option<JobView> => {
  const { job, now, walletLinks } = input
  const events = eventsOf(job, input.events)
  const request = events.request
  if (request === undefined) return Option.none()
  const buyer = request.event.pubkey
  const chain = chainOf(job, input.chain)
  const funded = fundedProposalOf(chain, buyer, events)
  const worker = funded?.event.pubkey ?? null
  const stage = stageOf(job, buyer, events, chain)
  const proposals = events.proposals.map((proposal): ProposalView => ({
    ...signedFields(proposal),
    superseded: isSuperseded(proposal, events.proposals),
    withdrawn: isWithdrawn(proposal, events.statements),
    expired: isExpired(proposal, now),
    accepted: isAcceptedBy(buyer, proposal, events.accepts),
    funded: proposal.event.id === funded?.event.id,
    otherBuyer: proposal.content.buyer !== buyer,
  }))
  return Option.some({
    job,
    stage,
    buyer,
    worker,
    request: {
      ...signedFields(request),
      expired: now >= request.content.expiresAt,
      closedByBuyer: closedByBuyer(job, buyer, events.statements),
    },
    proposals,
    accepts: acceptViews(buyer, events),
    funding: fundingView(chain, buyer, events, walletLinks),
    delivery: chain.delivery,
    rejection: chain.rejection,
    ending: chain.ending,
    deadlines: deadlinesOf(stage, chain, now),
    deliveryNotes: deliveryNoteViews(events.deliveryNotes, worker, chain),
    statements: statementViews(job, buyer, events),
    reviews: reviewViews(events.reviews, stage, chain, walletLinks),
  })
}

/**
 * Folds every job whose request is in a mixed bag of events, in order of job id. Events whose request is missing
 * fold into nothing.
 */
export const foldJobs = (input: FoldContext & { readonly events: ReadonlyArray<JobEvent> }): ReadonlyArray<JobView> => {
  const byJob = new Map<EventId, Array<JobEvent>>()
  for (const event of input.events) {
    const job = jobOfEvent(event)
    const bag = byJob.get(job) ?? []
    bag.push(event)
    byJob.set(job, bag)
  }
  return [...byJob.entries()]
    .toSorted(([left], [right]) => compareText(left, right))
    .flatMap(([job, events]) => Option.toArray(foldJob({ ...input, job, events })))
}
