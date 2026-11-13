import type { EventId, PublicKey } from '@sidequest/nostr'
import type { UnixSeconds } from '@sidequest/protocol'
import { Match } from 'effect'
import type { JobChain } from './Chain.ts'
import type { ChainEnding, OperatorOutcome } from './ChainFacts.ts'
import type { JobEvents } from './Events.ts'
import type { Judged } from './Grants.ts'
import { type Deadlines, settledStages, type Stage } from './JobView.ts'
import { closedByBuyer, isAcceptedBy, isWithdrawn } from './Negotiation.ts'

const outcomeStages: Readonly<Record<OperatorOutcome, Stage>> = {
  Approved: 'released',
  AcceptedBySilence: 'released',
  Ruled: 'ruled',
  Unruled: 'refunded',
  Undelivered: 'refunded',
}

const endingStage = (ending: ChainEnding): Stage =>
  Match.valueTags(ending, {
    Settled: ({ outcome }) => outcomeStages[outcome],
    Reclaimed: (): Stage => 'reclaimed',
  })

/** The stage the chain says, once it funded the job: the ending, else a rejection, a delivery or the funding. */
const chainStage = (chain: JobChain): Stage | undefined => {
  if (chain.funding === null) return undefined
  if (chain.ending !== null) return endingStage(chain.ending)
  if (chain.rejection !== null) return 'rejected'
  return chain.delivery === null ? 'funded' : 'delivered'
}

/**
 * The stage the events say before funding: `closed` if the buyer withdrew the request, `accepted` if the buyer accepted
 * a proposal, `proposed` if a proposal for this buyer is not withdrawn, else `open`. Expiry never moves it. The buyer
 * and the bidders act themselves or through agents under their grants (`Grants.ts`).
 */
const negotiationStage = (job: EventId, buyer: PublicKey, events: JobEvents, judged: Judged): Stage => {
  if (closedByBuyer(job, buyer, events.statements, judged)) return 'closed'
  if (events.proposals.some((proposal) => isAcceptedBy(buyer, proposal, events.accepts, judged))) return 'accepted'
  const live = events.proposals.filter(
    (proposal) => proposal.content.buyer === buyer && !isWithdrawn(proposal, events.statements, judged),
  )
  return live.length > 0 ? 'proposed' : 'open'
}

/** The job's stage: the chain's once it funded the job, the events' before. */
export const stageOf = (job: EventId, buyer: PublicKey, events: JobEvents, chain: JobChain, judged: Judged): Stage =>
  chainStage(chain) ?? negotiationStage(job, buyer, events, judged)

/** The deadline labels: the chain's deadlines compared with `now`, each only in its own stage. */
export const deadlinesOf = (stage: Stage, chain: JobChain, now: UnixSeconds): Deadlines => {
  const { funding, delivery, rejection } = chain
  return {
    deliveryOverdue: stage === 'funded' && funding !== null && now >= funding.deliveryDeadline,
    reviewWindowOpen: stage === 'delivered' && delivery !== null && now < delivery.reviewEndsAt,
    arbitrationOpen: stage === 'rejected' && rejection !== null && now < rejection.arbitrationEndsAt,
    reclaimable: funding !== null && !settledStages.has(stage) && now >= funding.authorizationExpiry,
  }
}
