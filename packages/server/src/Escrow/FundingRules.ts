import type { EscrowRefusalReason } from '@sidequest/protocol'
import { Option } from 'effect'
import type { Standing } from './Standing.ts'

/** EVM accounts (`eip155:…`) name case-insensitive hex addresses; links carry them lowercase, the chain checksummed. */
const canonical = (account: string) => (account.startsWith('eip155:') ? account.toLowerCase() : account)

/**
 * The first rule that keeps the server from relaying `fund` for a proposal of a job, or `undefined` when
 * all hold. `receiver` is the payment's receiver as CAIP-10 on the chain's network, `now` the time the labels are
 * judged at (the index's clock, as the fold's `expired` label is). In order:
 *
 * 1. the request is indexed and valid (`RequestNotIndexed`);
 * 2. the proposal is indexed, valid and for this job (`ProposalNotIndexed`), and names the request's author as its
 *    buyer (`ProposalForOtherBuyer`);
 * 3. the payment pays the proposal's `payTo` (`ReceiverNotPayTo`);
 * 4. the payer's wallet has a current verified link to the request's author (`PayerNotLinked`);
 * 5. the proposal is still offered: before its `validUntil` (`ProposalExpired`), not withdrawn (`ProposalWithdrawn`),
 *    authorised (`ProposalNotAuthorised`) and not superseded (`ProposalSuperseded`) by its bidder. The bidder is the
 *    proposal's author, or the operator whose grant let the agent key that signed it propose (`@sidequest/fold`'s grant
 *    rule): they and their agents withdraw and revise alike. A proposal naming a grant that does not authorise it
 *    (unknown, for another key, without `propose`, outside its window, or revoked) is no operator's offer
 *    (`ProposalNotAuthorised`, with the grant's refusal as its detail): its `payTo` names the operator's wallet for an
 *    offer the operator does not stand behind;
 * 6. the chain has not funded the job (`AlreadyFunded`).
 *
 * Rules 2 and 4 are about the buyer, who is always the request's signer: no scope lets an agent post a request, and the
 * payer's wallet must be linked to the buyer's own key, since only wallet signatures bind and an agent's key holds no
 * wallet. An agent's proposal pays its operator's wallet: the gateway writes the operator's verified wallet as `payTo`,
 * and rule 3 holds the payment to it.
 *
 * The chain's own checks (amounts, windows, the signature) come after, in the relayer's simulation. None of this stops
 * anyone funding on chain directly; it only keeps Sidequest's gas from paying for what the signed events refuse.
 */
export const fundingRefusal = (standing: Standing, receiver: string, now: number): EscrowRefusalReason | undefined => {
  if (Option.isNone(standing.request)) return 'RequestNotIndexed'
  if (Option.isNone(standing.proposal)) return 'ProposalNotIndexed'
  const request = standing.request.value.event
  const { content } = standing.proposal.value
  if (content.buyer !== request.pubkey) return 'ProposalForOtherBuyer'
  if (canonical(content.payTo) !== canonical(receiver)) return 'ReceiverNotPayTo'
  if (!Option.contains(standing.payerHolder, request.pubkey)) return 'PayerNotLinked'
  if (now >= content.validUntil) return 'ProposalExpired'
  if (standing.withdrawn) return 'ProposalWithdrawn'
  if (standing.bidderGrant !== null) return 'ProposalNotAuthorised'
  if (standing.superseded) return 'ProposalSuperseded'
  if (standing.fundedOnChain) return 'AlreadyFunded'
  return undefined
}

/** What a refusal adds to its reason: for a proposal under a grant that does not authorise it, why not. */
export const refusalDetail = (standing: Standing, reason: EscrowRefusalReason): string | undefined =>
  reason === 'ProposalNotAuthorised' && standing.bidderGrant !== null
    ? `The grant the proposal names does not authorise it: ${standing.bidderGrant}.`
    : undefined
