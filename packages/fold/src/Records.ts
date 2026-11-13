import type { EventId, PublicKey } from '@sidequest/nostr'
import type { DeliveryNoteContent, JobReviewContent, ParsedEvent } from '@sidequest/nostr/vocabulary'
import type { JobChain } from './Chain.ts'
import type { ChainFunded } from './ChainFacts.ts'
import { compareText } from './Events.ts'
import { isLinked } from './Funding.ts'
import type { WalletLinkFact } from './JobInput.ts'
import { type DeliveryNoteView, type ReviewSide, type ReviewView, settledStages, type Stage } from './JobView.ts'
import { signedFields } from './Negotiation.ts'

type Review = ParsedEvent<JobReviewContent>

/** Every delivery note: whether the worker signed it, and whether its hash is the one on chain. */
export const deliveryNoteViews = (
  notes: ReadonlyArray<ParsedEvent<DeliveryNoteContent>>,
  worker: PublicKey | null,
  chain: JobChain,
): ReadonlyArray<DeliveryNoteView> =>
  notes.map((note) => ({
    ...signedFields(note),
    fromWorker: worker !== null && note.event.pubkey === worker,
    matchesChain: chain.delivery !== null && note.content.deliveryHash === chain.delivery.deliveryHash,
  }))

/** The escrow side a key is linked to: the payer's wallet first, then the receiver's. */
const sideOf = (
  author: PublicKey,
  funding: ChainFunded | null,
  links: ReadonlyArray<WalletLinkFact>,
): ReviewSide | null => {
  if (funding === null) return null
  if (isLinked(links, funding.payer, author)) return 'payer'
  return isLinked(links, funding.receiver, author) ? 'receiver' : null
}

/** The review that counts for a side: the latest by `created_at`, ties to the lowest id. */
const countedOf = (reviews: ReadonlyArray<{ readonly review: Review; readonly side: ReviewSide | null }>) => {
  const latest = (side: ReviewSide): EventId | undefined =>
    reviews
      .filter((entry) => entry.side === side)
      .map((entry) => entry.review.event)
      .toSorted((left, right) => right.created_at - left.created_at || compareText(left.id, right.id))[0]?.id
  return new Set([latest('payer'), latest('receiver')])
}

/** Every review with its side and whether it counts: only once settled, only from a linked key, one per side. */
export const reviewViews = (
  reviews: ReadonlyArray<Review>,
  stage: Stage,
  chain: JobChain,
  links: ReadonlyArray<WalletLinkFact>,
): ReadonlyArray<ReviewView> => {
  const sided = reviews.map((review) => ({ review, side: sideOf(review.event.pubkey, chain.funding, links) }))
  const counted = countedOf(sided)
  const statusOf = (review: Review, side: ReviewSide | null): ReviewView['status'] => {
    if (!settledStages.has(stage)) return 'jobNotSettled'
    if (side === null) return 'stranger'
    return counted.has(review.event.id) ? 'counted' : 'replaced'
  }
  return sided.map(({ review, side }) => ({ ...signedFields(review), side, status: statusOf(review, side) }))
}
