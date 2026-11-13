import type { IndexSettlementReason } from '@sidequest/protocol'
import { Option } from 'effect'
import type { Standing } from './Standing.ts'

/** EVM accounts (`eip155:…`) name case-insensitive hex addresses; links carry them lowercase, the chain checksummed. */
const canonical = (account: string) => (account.startsWith('eip155:') ? account.toLowerCase() : account)

/**
 * The first rule that keeps the server from relaying `fund` for a proposal of a Nostr-native job, or `undefined` when
 * all hold. `receiver` is the payment's receiver as CAIP-10 on the chain's network, `now` the time the labels are
 * judged at (the index's clock, as the fold's `expired` label is). In order:
 *
 * 1. the request is indexed and valid (`RequestNotIndexed`);
 * 2. the proposal is indexed, valid and for this job (`ProposalNotIndexed`), and names the request's author as its
 *    buyer (`ProposalForOtherBuyer`);
 * 3. the payment pays the proposal's `payTo` (`ReceiverNotPayTo`);
 * 4. the payer's wallet has a current verified link to the request's author (`PayerNotLinked`);
 * 5. the proposal is still offered: before its `validUntil` (`ProposalExpired`), not withdrawn (`ProposalWithdrawn`)
 *    and not superseded (`ProposalSuperseded`) by its author;
 * 6. the chain has not funded the job (`AlreadyFunded`).
 *
 * The chain's own checks (amounts, windows, the signature) come after, in the relayer's simulation. None of this stops
 * anyone funding on chain directly; it only keeps Sidequest's gas from paying for what the signed events refuse.
 */
export const fundingRefusal = (
  standing: Standing,
  receiver: string,
  now: number,
): IndexSettlementReason | undefined => {
  if (Option.isNone(standing.request)) return 'RequestNotIndexed'
  if (Option.isNone(standing.proposal)) return 'ProposalNotIndexed'
  const request = standing.request.value.event
  const { content } = standing.proposal.value
  if (content.buyer !== request.pubkey) return 'ProposalForOtherBuyer'
  if (canonical(content.payTo) !== canonical(receiver)) return 'ReceiverNotPayTo'
  if (!Option.contains(standing.payerHolder, request.pubkey)) return 'PayerNotLinked'
  if (now >= content.validUntil) return 'ProposalExpired'
  if (standing.withdrawn) return 'ProposalWithdrawn'
  if (standing.superseded) return 'ProposalSuperseded'
  if (standing.fundedOnChain) return 'AlreadyFunded'
  return undefined
}
