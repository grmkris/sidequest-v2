import * as Domain from '@alchemy.run/domain'
import { JobId, termsDigest } from '@sidequest/protocol'
import { Effect, Predicate } from 'effect'
import { asPerson, asSystem, requireRole, sentBySystem, unixSeconds, withScope } from '../Authority.ts'
import { ExpiryNotInFuture } from '../ExpiryNotInFuture.rejection.ts'
import { NotPermitted } from '../NotPermitted.rejection.ts'
import { AcceptProposal, ProposalAccepted } from './AcceptProposal.command.ts'
import { ApproveDelivery, DeliveryApproved } from './ApproveDelivery.command.ts'
import { CancelRequest, RequestCancelled } from './CancelRequest.command.ts'
import { ExpireRequest, RequestExpired } from './ExpireRequest.command.ts'
import {
  Awarded,
  Delivered,
  Disputed,
  Funded,
  inAwarded,
  inDelivered,
  inDisputed,
  inEscrow,
  inFunded,
  inOpen,
  inSettled,
  inUnposted,
  JobStatus,
  Open,
  Settled,
} from './JobStatus.ts'
import { AlreadyReviewed, LeaveReview, ReviewLeft } from './LeaveReview.command.ts'
import { headNamed } from './NamedProposal.ts'
import { matchReceipt } from './Receipts.ts'
import { DeliveryRecorded, RecordDelivery } from './RecordDelivery.command.ts'
import { FundingRecorded, RecordFunding } from './RecordFunding.command.ts'
import { AlreadyRuled, RecordRuling, RulingRecorded } from './RecordRuling.command.ts'
import { JobSettled, RecordSettlement } from './RecordSettlement.command.ts'
import { AlreadyApproved, DeliveryRejected, RejectDelivery, ReviewWindowClosed } from './RejectDelivery.command.ts'
import { PostRequest, RequestPosted } from './PostRequest.command.ts'
import { ChangeRequested, RequestChange } from './RequestChange.command.ts'
import { DeliveryLate, DeliverySubmitted, SubmitDelivery } from './SubmitDelivery.command.ts'
import { ProposalSubmitted, SelfBid, StaleHead, SubmitProposal } from './SubmitProposal.command.ts'

const rulingOf = (workerShareBps: number) =>
  workerShareBps === 10_000 ? 'pay' : workerShareBps === 0 ? 'refund' : 'split'

/**
 * The lifecycle of one work request: `Open → Awarded → Funded → Delivered → Settled`, with `Disputed` between
 * `Delivered` and `Settled`, and the terminal `Cancelled` and `Expired`. People and agents propose, agree and
 * deliver; only the system moves money stages, from what the chain reader verified.
 */
export class Job extends Domain.Aggregate('Job', {
  id: JobId,
  state: JobStatus,
  initial: { _tag: 'Unposted' },
  commands: [
    PostRequest,
    SubmitProposal,
    RequestChange,
    AcceptProposal,
    CancelRequest,
    ExpireRequest,
    RecordFunding,
    SubmitDelivery,
    RecordDelivery,
    ApproveDelivery,
    RejectDelivery,
    RecordRuling,
    RecordSettlement,
    LeaveReview,
  ],
  decide: {
    PostRequest: Effect.fn(function* (state, command, { id, now }) {
      const buyer = yield* withScope('discuss', now)
      yield* inUnposted(state)
      const at = unixSeconds(now)
      if (command.expiresAt <= at) return yield* new ExpiryNotInFuture({ expiresAt: command.expiresAt, now: at })
      const { title, description, expiresAt } = command
      return [new RequestPosted({ request: { id, buyer, title, description, expiresAt } })]
    }),
    SubmitProposal: Effect.fn(function* (state, command, { id, now }) {
      const bidder = yield* withScope('propose', now)
      const open = yield* inOpen(state)
      if (bidder === open.buyer) return yield* new SelfBid({ bidder })
      const head = open.heads[bidder]
      if ((command.previous ?? null) !== (head?.version ?? null))
        return yield* new StaleHead({ head: head?.version ?? null, previous: command.previous ?? null })
      const digest = yield* termsDigest(command.terms)
      const proposal = { id: command.proposal, job: id, bidder, terms: command.terms, termsDigest: digest }
      return [
        new ProposalSubmitted({
          proposal:
            head === undefined
              ? { ...proposal, version: 1 }
              : { ...proposal, version: head.version + 1, previous: head.version },
        }),
      ]
    }),
    RequestChange: Effect.fn(function* (state, command, { now }) {
      const account = yield* withScope('discuss', now)
      const open = yield* inOpen(state)
      yield* requireRole(account, open.buyer, 'buyer')
      const head = yield* headNamed(open, command)
      return [new ChangeRequested({ bidder: command.bidder, version: head.version, termsDigest: head.termsDigest })]
    }),
    AcceptProposal: Effect.fn(function* (state, command, { id, now }) {
      const account = yield* withScope('accept', now)
      const open = yield* inOpen(state)
      yield* requireRole(account, open.buyer, 'buyer')
      const { proposal, version, terms, termsDigest: digest } = yield* headNamed(open, command)
      const agreement = {
        job: id,
        buyer: open.buyer,
        worker: command.bidder,
        proposal,
        version,
        terms,
        termsDigest: digest,
      }
      return [new ProposalAccepted({ agreement })]
    }),
    CancelRequest: Effect.fn(function* (state) {
      const account = yield* asPerson()
      const open = yield* inOpen(state)
      yield* requireRole(account, open.buyer, 'buyer')
      return [new RequestCancelled()]
    }),
    ExpireRequest: Effect.fn(function* (state, _, { now }) {
      const due = Predicate.isTagged(state, 'Open') && unixSeconds(now) >= state.expiresAt
      return due && (yield* sentBySystem) ? [new RequestExpired()] : []
    }),
    RecordFunding: Effect.fn(function* (state, { receipt }) {
      yield* asSystem()
      const { agreement } = yield* inAwarded(state)
      yield* matchReceipt(receipt, { agreement, operations: ['authorize'], amount: agreement.terms.amount })
      return [new FundingRecorded({ receipt })]
    }),
    SubmitDelivery: Effect.fn(function* (state, command, { id, now }) {
      const account = yield* withScope('deliver', now)
      const { agreement } = yield* inFunded(state)
      yield* requireRole(account, agreement.worker, 'worker')
      const at = unixSeconds(now)
      const deadline = agreement.terms.deliveryDeadline
      if (at > deadline) return yield* new DeliveryLate({ deadline, now: at })
      return [new DeliverySubmitted({ delivery: { job: id, artifactHash: command.artifactHash, url: command.url } })]
    }),
    RecordDelivery: Effect.fn(function* (state, { artifactHash, deliveredAt }) {
      yield* asSystem()
      const { agreement } = yield* inFunded(state)
      const reviewEndsAt = deliveredAt + agreement.terms.reviewWindowSeconds
      return [new DeliveryRecorded({ artifactHash, deliveredAt, reviewEndsAt })]
    }),
    ApproveDelivery: Effect.fn(function* (state, _, { now }) {
      const account = yield* asPerson()
      const delivered = yield* inDelivered(state)
      yield* requireRole(account, delivered.agreement.buyer, 'buyer')
      return delivered.approvedAt === null ? [new DeliveryApproved({ approvedAt: unixSeconds(now) })] : []
    }),
    RejectDelivery: Effect.fn(function* (state, { reason }, { now }) {
      const account = yield* asPerson()
      const delivered = yield* inDelivered(state)
      yield* requireRole(account, delivered.agreement.buyer, 'buyer')
      if (delivered.approvedAt !== null) return yield* new AlreadyApproved({ approvedAt: delivered.approvedAt })
      const at = unixSeconds(now)
      if (at > delivered.reviewEndsAt) return yield* new ReviewWindowClosed({ endsAt: delivered.reviewEndsAt, now: at })
      return [new DeliveryRejected({ reason })]
    }),
    RecordRuling: Effect.fn(function* (state, { workerShareBps }) {
      yield* asSystem()
      const disputed = yield* inDisputed(state)
      if (disputed.workerShareBps !== null) return yield* new AlreadyRuled({ workerShareBps: disputed.workerShareBps })
      return [new RulingRecorded({ workerShareBps, ruling: rulingOf(workerShareBps) })]
    }),
    RecordSettlement: Effect.fn(function* (state, { receipts }) {
      yield* asSystem()
      const escrow = yield* inEscrow(state)
      const { agreement } = escrow
      // Undelivered work is never paid: only a void or the buyer's reclaim can settle it.
      const operations = Predicate.isTagged(escrow, 'Funded')
        ? (['void', 'reclaim'] as const)
        : (['capture', 'void', 'reclaim'] as const)
      yield* Effect.forEach(receipts, (receipt) => matchReceipt(receipt, { agreement, operations }), { discard: true })
      const paid = receipts.some((receipt) => receipt.operation === 'capture')
      const refunded = receipts.some((receipt) => receipt.operation !== 'capture')
      const outcome = paid && refunded ? 'split' : paid ? 'paid' : 'refunded'
      return [new JobSettled({ buyer: agreement.buyer, worker: agreement.worker, outcome, receipts })]
    }),
    LeaveReview: Effect.fn(function* (state, { rating, comment }, { id, now }) {
      const author = yield* withScope('discuss', now)
      const settled = yield* inSettled(state)
      const subject = author === settled.buyer ? settled.worker : author === settled.worker ? settled.buyer : undefined
      if (subject === undefined) return yield* new NotPermitted({ account: author, required: 'party' })
      if (settled.reviewed.includes(author)) return yield* new AlreadyReviewed({ author })
      const review = { job: id, author, subject, rating }
      return [new ReviewLeft({ review: comment === undefined ? review : { ...review, comment } })]
    }),
  },
  evolve: {
    RequestPosted: (_, { request }) => Open.make({ buyer: request.buyer, expiresAt: request.expiresAt, heads: {} }),
    ProposalSubmitted: (state, { proposal }) => {
      if (!Predicate.isTagged(state, 'Open')) return state
      const { id, version, terms, termsDigest: digest } = proposal
      return {
        ...state,
        heads: { ...state.heads, [proposal.bidder]: { proposal: id, version, terms, termsDigest: digest } },
      }
    },
    ChangeRequested: (state) => state,
    ProposalAccepted: (_, { agreement }) => Awarded.make({ agreement }),
    RequestCancelled: () => ({ _tag: 'Cancelled' as const }),
    RequestExpired: () => ({ _tag: 'Expired' as const }),
    FundingRecorded: (state) =>
      Predicate.isTagged(state, 'Awarded') ? Funded.make({ agreement: state.agreement }) : state,
    DeliverySubmitted: (state) => state,
    DeliveryRecorded: (state, { reviewEndsAt }) =>
      Predicate.isTagged(state, 'Funded')
        ? Delivered.make({ agreement: state.agreement, reviewEndsAt, approvedAt: null })
        : state,
    DeliveryApproved: (state, { approvedAt }) =>
      Predicate.isTagged(state, 'Delivered') ? { ...state, approvedAt } : state,
    DeliveryRejected: (state) =>
      Predicate.isTagged(state, 'Delivered')
        ? Disputed.make({ agreement: state.agreement, workerShareBps: null })
        : state,
    RulingRecorded: (state, { workerShareBps }) =>
      Predicate.isTagged(state, 'Disputed') ? { ...state, workerShareBps } : state,
    JobSettled: (_, { buyer, worker }) => Settled.make({ buyer, worker, reviewed: [] }),
    ReviewLeft: (state, { review }) =>
      Predicate.isTagged(state, 'Settled') ? { ...state, reviewed: [...state.reviewed, review.author] } : state,
  },
}) {}
