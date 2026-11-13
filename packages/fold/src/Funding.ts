import type { PublicKey } from '@sidequest/nostr'
import type { JobProposalContent, ParsedEvent } from '@sidequest/nostr/vocabulary'
import type { Terms } from '@sidequest/protocol'
import type { JobChain } from './Chain.ts'
import type { ChainFunded } from './ChainFacts.ts'
import { compareText, type JobEvents } from './Events.ts'
import type { Judged } from './Grants.ts'
import type { WalletLinkFact } from './JobInput.ts'
import type { FundingView } from './JobView.ts'
import { isAcceptedBy } from './Negotiation.ts'

type Proposal = ParsedEvent<JobProposalContent>

/**
 * EVM accounts and assets (`eip155:…`) name hex addresses, which are case-insensitive: the chain reader writes them
 * checksummed and wallet links lowercase. Other namespaces may be case-sensitive and are compared exactly.
 */
const canonical = (reference: string) => (reference.startsWith('eip155:') ? reference.toLowerCase() : reference)
const sameReference = (left: string, right: string) => canonical(left) === canonical(right)

/** Whether a current wallet link says `wallet` belongs to `pubkey`. */
export const isLinked = (links: ReadonlyArray<WalletLinkFact>, wallet: string, pubkey: PublicKey): boolean =>
  links.some((link) => link.pubkey === pubkey && sameReference(link.wallet, wallet))

const termsMatchChain = (terms: Terms, funding: ChainFunded): boolean =>
  terms.amount === funding.amount &&
  sameReference(terms.asset, funding.asset) &&
  terms.deliveryDeadline === funding.deliveryDeadline &&
  terms.reviewWindowSeconds === funding.reviewWindowSeconds &&
  terms.disputeWindowSeconds === funding.disputeWindowSeconds &&
  terms.arbitrationWindowSeconds === funding.arbitrationWindowSeconds

/**
 * The funded proposal: one whose job, terms digest and `payTo` are the chain's job, terms digest and receiver. Its
 * other labels (withdrawn, superseded, expired) and whose it is do not matter. When several match, one the buyer
 * accepted wins, then the lowest id.
 */
const fundedCandidates = (
  funding: ChainFunded,
  buyer: PublicKey,
  events: JobEvents,
  judged: Judged,
): ReadonlyArray<Proposal> =>
  events.proposals
    .filter(
      (proposal) =>
        proposal.content.termsDigest === funding.termsDigest && sameReference(proposal.content.payTo, funding.receiver),
    )
    .toSorted(
      (left, right) =>
        Number(isAcceptedBy(buyer, right, events.accepts, judged)) -
          Number(isAcceptedBy(buyer, left, events.accepts, judged)) || compareText(left.event.id, right.event.id),
    )

/** The funded proposal, if a known one matches. */
export const fundedProposalOf = (
  chain: JobChain,
  buyer: PublicKey,
  events: JobEvents,
  judged: Judged,
): Proposal | undefined =>
  chain.funding === null ? undefined : fundedCandidates(chain.funding, buyer, events, judged)[0]

/** The funding with its labels, or `null` before the chain funds the job; `worker` is the funded proposal's bidder. */
export const fundingView = (
  chain: JobChain,
  buyer: PublicKey,
  worker: PublicKey | null,
  events: JobEvents,
  links: ReadonlyArray<WalletLinkFact>,
  judged: Judged,
): FundingView | null => {
  const funding = chain.funding
  if (funding === null) return null
  const candidates = fundedCandidates(funding, buyer, events, judged)
  const proposal = candidates[0]
  return {
    fact: funding,
    proposal: proposal?.event.id ?? null,
    terms: proposal === undefined ? 'unknown' : 'known',
    termsAmbiguous: candidates.length > 1,
    termsMatchChain: proposal !== undefined && termsMatchChain(proposal.content.terms, funding),
    payerLinked: isLinked(links, funding.payer, buyer),
    receiverLinked: worker !== null && isLinked(links, funding.receiver, worker),
    otherPayments: chain.otherPayments,
  }
}
