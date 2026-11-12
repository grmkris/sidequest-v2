import * as Domain from '@alchemy.run/domain'
import { AccountId, JobId, Proposal, ProposalId, ProposalVersion, Terms } from '@sidequest/protocol'
import { Schema } from 'effect'
import { scopedRejections } from '../Authority.ts'
import { Session } from '../Session.middleware.ts'
import { WrongState } from './WrongState.rejection.ts'

/** The buyer may not bid on their own request. */
export class SelfBid extends Domain.Rejection('SelfBid', { bidder: AccountId }) {}

/** `previous` does not name the bidder's head (absent: they have none yet). */
export class StaleHead extends Domain.Rejection('StaleHead', {
  head: Schema.NullOr(ProposalVersion),
  previous: Schema.NullOr(ProposalVersion),
}) {}

export class ProposalSubmitted extends Domain.Event('ProposalSubmitted', { proposal: Proposal }) {}

/**
 * A bidder, or their agent with `propose`, offers terms. The first proposal is version 1 and names no `previous`;
 * each later one names the bidder's head as `previous` and becomes `previous + 1`.
 */
export class SubmitProposal extends Domain.Command('SubmitProposal', {
  target: JobId,
  middleware: [Session],
  input: { proposal: ProposalId, previous: Schema.optionalKey(ProposalVersion), terms: Terms },
  events: [ProposalSubmitted],
  rejects: [...scopedRejections, WrongState, SelfBid, StaleHead],
}) {}
