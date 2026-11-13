import type { PublicKey } from '@sidequest/nostr'
import type { JobProposalContent, ParsedEvent } from '@sidequest/nostr/vocabulary'
import type { Terms } from '@sidequest/protocol'
import type { JobChain } from './Chain.ts'
import type { ChainFunded } from './ChainFacts.ts'
import { compareText, type JobEvents } from './Events.ts'
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
 * other labels (withdrawn, superseded, expired) do not matter. When several match, one the buyer accepted wins, then
 * the lowest id.
 */
const fundedCandidates = (funding: ChainFunded, buyer: PublicKey, events: JobEvents): ReadonlyArray<Proposal> =>
  events.proposals
    .filter(
      (proposal) =>
        proposal.content.termsDigest === funding.termsDigest && sameReference(proposal.content.payTo, funding.receiver),
    )
    .toSorted(
      (left, right) =>
        Number(isAcceptedBy(buyer, right, events.accepts)) - Number(isAcceptedBy(buyer, left, events.accepts)) ||
        compareText(left.event.id, right.event.id),
    )

/** The funded proposal, if a known one matches. */
export const fundedProposalOf = (chain: JobChain, buyer: PublicKey, events: JobEvents): Proposal | undefined =>
  chain.funding === null ? undefined : fundedCandidates(chain.funding, buyer, events)[0]

/** The funding with its labels, or `null` before the chain funds the job. */
export const fundingView = (
  chain: JobChain,
  buyer: PublicKey,
  events: JobEvents,
  links: ReadonlyArray<WalletLinkFact>,
): FundingView | null => {
  const funding = chain.funding
  if (funding === null) return null
  const candidates = fundedCandidates(funding, buyer, events)
  const proposal = candidates[0]
  return {
    fact: funding,
    proposal: proposal?.event.id ?? null,
    terms: proposal === undefined ? 'unknown' : 'known',
    termsAmbiguous: candidates.length > 1,
    termsMatchChain: proposal !== undefined && termsMatchChain(proposal.content.terms, funding),
    payerLinked: isLinked(links, funding.payer, buyer),
    receiverLinked: proposal !== undefined && isLinked(links, funding.receiver, proposal.event.pubkey),
    otherPayments: chain.otherPayments,
  }
}
