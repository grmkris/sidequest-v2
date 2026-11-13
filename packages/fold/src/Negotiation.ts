import type { EventId, PublicKey } from '@sidequest/nostr'
import type { JobAcceptContent, JobProposalContent, ParsedEvent, StatementContent } from '@sidequest/nostr/vocabulary'
import type { UnixSeconds } from '@sidequest/protocol'
import { Option } from 'effect'
import type { JobEvents } from './Events.ts'
import type { Judged } from './Grants.ts'
import type { AcceptView, StatementView } from './JobView.ts'

type Proposal = ParsedEvent<JobProposalContent>
type Accept = ParsedEvent<JobAcceptContent>
type Statement = ParsedEvent<StatementContent>

/** The fields every view of a signed event starts with. */
export const signedFields = <C>(parsed: ParsedEvent<C>) => ({
  id: parsed.event.id,
  author: parsed.event.pubkey,
  createdAt: parsed.event.created_at,
  content: parsed.content,
})

/** The signed fields and whose the event is, for the views of events a grant can carry. */
export const actingFields = <C>(parsed: ParsedEvent<C>, judged: Judged) => ({
  ...signedFields(parsed),
  ...judged.acting(parsed),
})

/** Whether the buyer withdrew the request: a `withdraw_request` statement of theirs, about nothing or the request. */
export const closedByBuyer = (
  job: EventId,
  buyer: PublicKey,
  statements: ReadonlyArray<Statement>,
  judged: Judged,
): boolean =>
  statements.some(
    (said) =>
      judged.principal(said) === buyer &&
      said.content.type === 'withdraw_request' &&
      (said.content.about === undefined || said.content.about === job),
  )

/** Whether a proposal's own bidder withdrew it. */
export const isWithdrawn = (proposal: Proposal, statements: ReadonlyArray<Statement>, judged: Judged): boolean =>
  statements.some(
    (said) =>
      said.content.type === 'withdraw_proposal' &&
      said.content.about === proposal.event.id &&
      judged.principal(said) === judged.principal(proposal),
  )

/** Whether a later proposal by the same bidder names this one as the proposal it replaces. */
export const isSuperseded = (proposal: Proposal, proposals: ReadonlyArray<Proposal>, judged: Judged): boolean =>
  proposals.some(
    (other) => other.content.previous === proposal.event.id && judged.principal(other) === judged.principal(proposal),
  )

/** Whether a proposal is still offered at `now`: before its `validUntil`. A label only. */
export const isExpired = (proposal: Proposal, now: UnixSeconds): boolean => now >= proposal.content.validUntil

/**
 * Whether an accept binds the proposal it names: same terms digest, the proposal's signing key as worker, its
 * network.
 */
const acceptMatches = (accept: Accept, proposal: Proposal): boolean =>
  accept.content.proposal === proposal.event.id &&
  accept.content.termsDigest === proposal.content.termsDigest &&
  accept.content.worker === proposal.event.pubkey &&
  Option.contains(accept.envelope.network, proposal.content.terms.network)

/** Whether the buyer (themselves, or an agent under their grant) signed an accept matching this proposal. */
export const isAcceptedBy = (
  buyer: PublicKey,
  proposal: Proposal,
  accepts: ReadonlyArray<Accept>,
  judged: Judged,
): boolean => accepts.some((accept) => judged.principal(accept) === buyer && acceptMatches(accept, proposal))

/** Every accept with its labels. */
export const acceptViews = (buyer: PublicKey, events: JobEvents, judged: Judged): ReadonlyArray<AcceptView> => {
  const isBuyers = (accept: Accept) => judged.principal(accept) === buyer
  const fromBuyer = events.accepts.filter(isBuyers)
  return events.accepts.map((accept): AcceptView => {
    const signed = isBuyers(accept)
    const named = events.proposals.find((proposal) => proposal.event.id === accept.content.proposal)
    return {
      id: accept.event.id,
      author: accept.event.pubkey,
      createdAt: accept.event.created_at,
      ...judged.acting(accept),
      proposal: accept.content.proposal,
      worker: accept.content.worker,
      fromBuyer: signed,
      matchesProposal: named !== undefined && acceptMatches(accept, named),
      conflicting: signed && fromBuyer.some((other) => other.content.proposal !== accept.content.proposal),
    }
  })
}

/** Whether a statement's principal may make it: see `StatementView.effective`. */
const isEffective = (job: EventId, buyer: PublicKey, statement: Statement, events: JobEvents, judged: Judged) => {
  const { content } = statement
  const principal = judged.principal(statement)
  switch (content.type) {
    case 'withdraw_request':
      return principal === buyer && (content.about === undefined || content.about === job)
    case 'rejection_reason':
      return principal === buyer
    case 'withdraw_proposal':
      return events.proposals.some(
        (proposal) => proposal.event.id === content.about && judged.principal(proposal) === principal,
      )
  }
}

/** Every statement with whether whoever it counts as may make it. */
export const statementViews = (
  job: EventId,
  buyer: PublicKey,
  events: JobEvents,
  judged: Judged,
): ReadonlyArray<StatementView> =>
  events.statements.map((statement) => ({
    ...actingFields(statement, judged),
    effective: isEffective(job, buyer, statement, events, judged),
  }))
