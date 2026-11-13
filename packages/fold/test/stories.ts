import { Terms } from '@sidequest/protocol'
import { Schema } from 'effect'
import type { ChainFact } from '../src/ChainFacts.ts'
import type { JobEvent, JobInput } from '../src/JobInput.ts'
import {
  accept,
  at,
  day,
  dearerTerms,
  delivered,
  digestOf,
  funded,
  hour,
  links,
  note,
  otherPayment,
  proposal,
  reclaimed,
  rejected,
  request,
  review,
  say,
  settled,
  terms,
  wallets,
} from './fixtures.ts'

/** The buyer posts, the worker proposes the stories' terms, the buyer accepts: the start of most stories. */
const hire = async () => {
  const posted = await request()
  const job = posted.parsed.event.id
  const offered = await proposal({ job, by: 'worker', createdAt: at(hour) })
  const accepted = await accept(offered.parsed, at(2 * hour))
  const funding = funded({ job, termsDigest: offered.parsed.content.termsDigest })
  return { job, posted, offered, accepted, funding, negotiation: [posted, offered, accepted] as const }
}

const base = await hire()
const { job } = base
export { job }

const input = (events: ReadonlyArray<JobEvent>, chain: ReadonlyArray<ChainFact>, now: number): JobInput => ({
  job,
  events,
  chain,
  now,
  walletLinks: links,
})
export const offered = base.offered.parsed

/** Another job's request and proposal, which every story carries and every fold must ignore. */
const elsewhere = await request(at(1))
const elsewhereProposal = await proposal({ job: elsewhere.parsed.event.id, by: 'rival', createdAt: at(hour) })
const noise = [elsewhere, elsewhereProposal] as const

const workerNote = await note(job, 'worker', at(5 * day))
const buyerReview = await review(job, 'buyer', 'worker', 5, at(7 * day))
const workerReview = await review(job, 'worker', 'buyer', 4, at(7 * day + 1))
export const paidIds = { note: workerNote.parsed.event.id, buyerReview: buyerReview.parsed.event.id }

/** Delivered, approved and paid in full; both sides review. */
export const paid = input(
  [...base.negotiation, ...noise, workerNote, buyerReview, workerReview],
  [base.funding, delivered(at(5 * day)), settled('Approved', 10_000, at(6 * day))],
  at(8 * day),
)

const reason = await say(job, 'buyer', 'rejection_reason', at(5 * day + hour))
const disputedChain = [base.funding, delivered(at(5 * day)), rejected(at(5 * day + hour))]
/** Delivered, rejected, still before the arbitrator's deadline. */
export const disputed = input([...base.negotiation, reason], disputedChain, at(6 * day))
/** The same dispute, split 60/40 by a ruling. */
export const ruled = input(
  [...base.negotiation, reason],
  [...disputedChain, settled('Ruled', 6_000, at(8 * day))],
  at(9 * day),
)

/** Funded, nothing delivered, the deadline passed: overdue, then refunded. */
export const overdue = input(base.negotiation, [base.funding], at(11 * day))
export const refunded = input(
  base.negotiation,
  [base.funding, settled('Undelivered', 0, at(11 * day))],
  at(11 * day + hour),
)

/** Delivered but never settled; the escrow's authorisation expired; then the payer reclaimed. */
const expiry = base.funding.authorizationExpiry
export const expiring = input(base.negotiation, [base.funding, delivered(at(5 * day))], expiry)
export const reclaimedJob = input(
  base.negotiation,
  [base.funding, delivered(at(5 * day)), reclaimed(expiry + hour)],
  expiry + 2 * hour,
)

/** The chain funded terms no known proposal offers. */
const unknownNote = await note(job, 'worker', at(5 * day))
export const unknownTerms = input(
  [base.posted, base.offered, unknownNote],
  [funded({ job, termsDigest: await digestOf(dearerTerms) })],
  at(4 * day),
)

const withdrawal = await say(job, 'worker', 'withdraw_proposal', at(3 * hour), offered.event.id)
/** The worker withdrew; the buyer funded the proposal on chain anyway. */
export const withdrawnUnfunded = input([base.posted, base.offered, withdrawal], [], at(4 * hour))
export const withdrawnFunded = input([base.posted, base.offered, withdrawal], [base.funding], at(4 * hour))

const rivalOffer = await proposal({ job, by: 'rival', createdAt: at(90 * 60) })
const rivalAccept = await accept(rivalOffer.parsed, at(3 * hour))
const strangerAccept = await accept(offered, at(4 * hour), 'stranger')
export const acceptIds = {
  worker: base.accepted.parsed.event.id,
  rival: rivalAccept.parsed.event.id,
  stranger: strangerAccept.parsed.event.id,
  rivalOffer: rivalOffer.parsed.event.id,
}
const bothAccepted = [base.posted, base.offered, rivalOffer, base.accepted, rivalAccept, strangerAccept]
/** The buyer accepted two bidders; a stranger accepted one too. */
export const conflicting = input(bothAccepted, [], at(5 * hour))
/** Then the buyer funded the rival. */
export const rivalFunded = input(
  bothAccepted,
  [funded({ job, termsDigest: rivalOffer.parsed.content.termsDigest, receiver: wallets.rival })],
  at(6 * hour),
)
/** The buyer funded the worker, then a second payment to the rival, which got delivered: only the first counts. */
export const fundedTwice = input(
  bothAccepted,
  [
    funded({ job, termsDigest: offered.content.termsDigest }),
    funded({
      job,
      termsDigest: rivalOffer.parsed.content.termsDigest,
      receiver: wallets.rival,
      block: 150,
      paymentHash: otherPayment,
    }),
    { ...delivered(at(day), 160), paymentHash: otherPayment },
  ],
  at(2 * day),
)
/** Only a stranger accepted: a proposal stays merely proposed. */
export const strangerOnly = input([base.posted, base.offered, strangerAccept], [], at(5 * hour))

const strangerReview = await review(job, 'stranger', 'worker', 1, at(7 * day))
const buyerFirst = await review(job, 'buyer', 'worker', 2, at(7 * day))
const buyerLater = await review(job, 'buyer', 'worker', 5, at(7 * day + 10))
const workerTwins = [
  await review(job, 'worker', 'buyer', 3, at(7 * day + 5)),
  await review(job, 'worker', 'buyer', 4, at(7 * day + 5)),
]
export const reviewIds = {
  stranger: strangerReview.parsed.event.id,
  buyerFirst: buyerFirst.parsed.event.id,
  buyerLater: buyerLater.parsed.event.id,
  workerTwins: workerTwins.map((twin) => twin.parsed.event.id).toSorted(),
}
const reviewEvents = [...base.negotiation, strangerReview, buyerFirst, buyerLater, ...workerTwins]
/** A settled job reviewed by a stranger, by the buyer twice, and by the worker twice in the same second. */
export const reviewed = input(reviewEvents, paid.chain, at(8 * day))
/** The same reviews while the job is only delivered. */
export const reviewedEarly = input(reviewEvents, paid.chain.slice(0, 2), at(6 * day))

const thirdTerms = Schema.decodeSync(Terms)({ ...Schema.encodeSync(Terms)(terms), amount: '140000000' })
const first = await proposal({ job, by: 'worker', createdAt: at(hour), offered: dearerTerms })
const second = await proposal({ job, by: 'worker', createdAt: at(2 * hour), previous: first.parsed.event.id })
const third = await proposal({
  job,
  by: 'worker',
  createdAt: at(3 * hour),
  offered: thirdTerms,
  previous: second.parsed.event.id,
})
const rivalRevision = await proposal({ job, by: 'rival', createdAt: at(4 * hour), previous: third.parsed.event.id })
export const revisionIds = [first, second, third, rivalRevision].map((revision) => revision.parsed.event.id)
/** Three revisions by the worker; the rival names the last as theirs to replace; the buyer funds the middle one. */
export const superseded = input(
  [base.posted, first, second, third, rivalRevision],
  [funded({ job, termsDigest: second.parsed.content.termsDigest })],
  at(5 * hour),
)

const closing = await say(job, 'buyer', 'withdraw_request', at(3 * hour))
const strangerClosing = await say(job, 'stranger', 'withdraw_request', at(3 * hour))
export const closingIds = { buyer: closing.parsed.event.id, stranger: strangerClosing.parsed.event.id }
/** The buyer withdrew the request, after a week it expired; a stranger's withdrawal says nothing. */
export const closed = input([base.posted, base.offered, closing, strangerClosing], [], at(8 * day))
export const expiredOpen = input([base.posted, base.offered, strangerClosing], [], at(8 * day))

/** Every story, for the order-independence property. */
export const stories = {
  paid,
  disputed,
  ruled,
  overdue,
  refunded,
  expiring,
  reclaimedJob,
  unknownTerms,
  withdrawnUnfunded,
  withdrawnFunded,
  conflicting,
  rivalFunded,
  fundedTwice,
  strangerOnly,
  reviewed,
  reviewedEarly,
  superseded,
  closed,
  expiredOpen,
}
