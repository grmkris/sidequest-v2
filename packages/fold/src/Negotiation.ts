import type { EventId, PublicKey } from '@sidequest/nostr'
import type { JobAcceptContent, JobProposalContent, ParsedEvent, StatementContent } from '@sidequest/nostr/vocabulary'
import type { UnixSeconds } from '@sidequest/protocol'
import { Option } from 'effect'
import type { JobEvents } from './Events.ts'
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

/** Whether the buyer withdrew the request: a `withdraw_request` statement by them, about nothing or the request. */
export const closedByBuyer = (job: EventId, buyer: PublicKey, statements: ReadonlyArray<Statement>): boolean =>
  statements.some(
    ({ event, content }) =>
      event.pubkey === buyer &&
      content.type === 'withdraw_request' &&
      (content.about === undefined || content.about === job),
  )

/** Whether a proposal's own author withdrew it. */
export const isWithdrawn = (proposal: Proposal, statements: ReadonlyArray<Statement>): boolean =>
  statements.some(
    ({ event, content }) =>
      content.type === 'withdraw_proposal' &&
      content.about === proposal.event.id &&
      event.pubkey === proposal.event.pubkey,
  )

/** Whether a later proposal by the same author names this one as the proposal it replaces. */
export const isSuperseded = (proposal: Proposal, proposals: ReadonlyArray<Proposal>): boolean =>
  proposals.some(
    (other) => other.content.previous === proposal.event.id && other.event.pubkey === proposal.event.pubkey,
  )

/** Whether a proposal is still offered at `now`: before its `validUntil`. A label only. */
export const isExpired = (proposal: Proposal, now: UnixSeconds): boolean => now >= proposal.content.validUntil

/** Whether an accept binds the proposal it names: same terms digest, the proposal's author as worker, its network. */
const acceptMatches = (accept: Accept, proposal: Proposal): boolean =>
  accept.content.proposal === proposal.event.id &&
  accept.content.termsDigest === proposal.content.termsDigest &&
  accept.content.worker === proposal.event.pubkey &&
  Option.contains(accept.envelope.network, proposal.content.terms.network)

/** Whether the buyer signed an accept matching this proposal. */
export const isAcceptedBy = (buyer: PublicKey, proposal: Proposal, accepts: ReadonlyArray<Accept>): boolean =>
  accepts.some((accept) => accept.event.pubkey === buyer && acceptMatches(accept, proposal))

/** Every accept with its labels. */
export const acceptViews = (buyer: PublicKey, events: JobEvents): ReadonlyArray<AcceptView> => {
  const fromBuyer = events.accepts.filter((accept) => accept.event.pubkey === buyer)
  return events.accepts.map((accept): AcceptView => {
    const signed = accept.event.pubkey === buyer
    const named = events.proposals.find((proposal) => proposal.event.id === accept.content.proposal)
    return {
      id: accept.event.id,
      author: accept.event.pubkey,
      createdAt: accept.event.created_at,
      proposal: accept.content.proposal,
      worker: accept.content.worker,
      fromBuyer: signed,
      matchesProposal: named !== undefined && acceptMatches(accept, named),
      conflicting: signed && fromBuyer.some((other) => other.content.proposal !== accept.content.proposal),
    }
  })
}

/** Whether a statement's author may make it: see `StatementView.effective`. */
const isEffective = (job: EventId, buyer: PublicKey, statement: Statement, events: JobEvents): boolean => {
  const { content, event } = statement
  switch (content.type) {
    case 'withdraw_request':
      return event.pubkey === buyer && (content.about === undefined || content.about === job)
    case 'rejection_reason':
      return event.pubkey === buyer
    case 'withdraw_proposal':
      return events.proposals.some(
        (proposal) => proposal.event.id === content.about && proposal.event.pubkey === event.pubkey,
      )
  }
}

/** Every statement with whether its author may make it. */
export const statementViews = (job: EventId, buyer: PublicKey, events: JobEvents): ReadonlyArray<StatementView> =>
  events.statements.map((statement) => ({
    ...signedFields(statement),
    effective: isEffective(job, buyer, statement, events),
  }))
