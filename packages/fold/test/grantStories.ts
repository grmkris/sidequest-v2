import type { ChainFact } from '../src/ChainFacts.ts'
import type { GrantFact, JobEvent, JobInput } from '../src/JobInput.ts'
import { accept, at, day, funded, grantFact, hour, links, note, proposal, request, say } from './fixtures.ts'

// Stories of agents acting under grants: the worker's agent proposes and delivers under the worker's grant, the
// buyer's agent accepts under the buyer's. Each grant rule is broken on its own in the story tests.

/** The worker lets their agent propose and deliver; the buyer lets theirs accept. Both for the stories' ten days. */
export const workerGrant = grantFact('a1', 'worker', 'agent', ['propose', 'deliver'])
export const buyerGrant = grantFact('b1', 'buyer', 'buyerAgent', ['accept'])
export const workerGrantId = workerGrant().grant
export const buyerGrantId = buyerGrant().grant

const posted = await request()
export const job = posted.parsed.event.id
/** The agent's proposal, paying its operator's (the worker's) wallet, as the gateway builds it. */
export const agentOffer = await proposal({ job, by: 'agent', createdAt: at(hour), grant: workerGrantId })
/** The buyer's agent accepts it under the buyer's grant. */
export const agentAccept = await accept(agentOffer.parsed, at(2 * hour), 'buyerAgent', buyerGrantId)
const funding = funded({ job, termsDigest: agentOffer.parsed.content.termsDigest })

export const input = (
  events: ReadonlyArray<JobEvent>,
  grants: ReadonlyArray<GrantFact>,
  chain: ReadonlyArray<ChainFact> = [],
  now = at(3 * hour),
): JobInput => ({ job, events, chain, now, walletLinks: links, grants })

const both = [workerGrant(), buyerGrant()]

/** Both agents act under their operators' grants: accepted. */
export const agentsAgree = input([posted, agentOffer, agentAccept], both)

/** The same accept under a grant broken one way: each still a signal, never the buyer's. */
export const acceptUnder = (grant: GrantFact | undefined) =>
  input([posted, agentOffer, agentAccept], [workerGrant(), ...(grant === undefined ? [] : [grant])])

const workerOwnNote = await note(job, 'worker', at(5 * day))
export const agentNote = await note(job, 'agent', at(5 * day + 1), undefined, workerGrantId)
export const ownNoteId = workerOwnNote.parsed.event.id

/** Funded; the agent's and the worker's own delivery notes. */
export const agentsFunded = (grants: ReadonlyArray<GrantFact>) =>
  input([posted, agentOffer, agentAccept, workerOwnNote, agentNote], grants, [funding], at(6 * day))

/** The worker withdraws their agent's proposal, signed with their own key. */
export const operatorWithdrawal = await say(
  job,
  'worker',
  'withdraw_proposal',
  at(3 * hour),
  agentOffer.parsed.event.id,
)
/** A stranger under a grant from the worker that lacks `propose`. */
export const strangerGrant = grantFact('c1', 'worker', 'stranger', ['accept'])
export const meddling = await say(
  job,
  'stranger',
  'withdraw_proposal',
  at(3 * hour),
  agentOffer.parsed.event.id,
  strangerGrant().grant,
)
/** The worker revises their agent's proposal with their own key. */
export const operatorRevision = await proposal({
  job,
  by: 'worker',
  createdAt: at(3 * hour),
  previous: agentOffer.parsed.event.id,
})

/** The buyer's agent closes the request under the buyer's grant (the `accept` scope). */
export const agentClosing = await say(job, 'buyerAgent', 'withdraw_request', at(3 * hour), undefined, buyerGrantId)

/** Every grant story, for the order-independence property: the revoked ones carry the grant twice, seen both ways. */
export const grantStories = {
  agentsAgree,
  acceptRevoked: acceptUnder(buyerGrant({ revoked: true })),
  acceptSeenBeforeAndAfterRevocation: input(
    [posted, agentOffer, agentAccept],
    [workerGrant(), buyerGrant(), buyerGrant({ revoked: true })],
  ),
  agentsFunded: agentsFunded(both),
  fundedThenRevoked: agentsFunded([workerGrant(), workerGrant({ revoked: true }), buyerGrant()]),
  withdrawnByOperator: input([posted, agentOffer, operatorWithdrawal, meddling], [workerGrant(), strangerGrant()]),
  revisedByOperator: input([posted, agentOffer, operatorRevision], both),
  closedByAgent: input([posted, agentOffer, agentClosing], both),
}
