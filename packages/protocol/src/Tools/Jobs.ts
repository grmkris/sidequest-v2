import { Schema } from 'effect'
import { Tool, Toolkit } from 'effect/ai'
import { Delivery } from '../Delivery.ts'
import { EscrowStatus } from '../EscrowStatus.ts'
import { JobId, ProposalId } from '../Id.ts'
import { JobView, ProposalRef } from '../JobView.ts'
import { Cursor, Page } from '../Page.ts'
import { ProposalVersion } from '../Proposal.ts'
import { Review } from '../Review.ts'
import { Terms } from '../Terms.ts'
import { OpenRequest, WorkRequest } from '../WorkRequest.ts'
import { NextAction, reading, ToolLimit, ToolRefusal, writing } from './Common.ts'

const onJob = { job: JobId.annotate({ description: 'The job’s id (`job_…`), which is also its request’s id.' }) }

/** What a command on a job answers: the job, and the step the person must take next on the website, if any. */
const JobStep = Schema.Struct({ job: JobId, nextAction: Schema.NullOr(NextAction) })

const ListOpenRequests = Tool.make('list_open_requests', {
  description:
    'List the open work requests buyers posted, newest first, that still take proposals. Pass `next` back as ' +
    '`cursor` for the following page. Needs no scope.',
  parameters: Schema.Struct({ limit: Schema.optionalKey(ToolLimit), cursor: Schema.optionalKey(Cursor) }),
  success: Page(OpenRequest),
  failure: ToolRefusal,
}).annotateMerge(reading)

const PostRequest = Tool.make('post_request', {
  description:
    'Post a work request for your operator as the buyer: what they need, open for proposals until `expiresAt` ' +
    '(Unix seconds, in the future). Answers the new job’s id. Needs the `discuss` scope.',
  parameters: Schema.Struct({
    title: WorkRequest.fields.title,
    description: WorkRequest.fields.description,
    expiresAt: WorkRequest.fields.expiresAt.annotate({ description: 'When the request closes, in Unix seconds.' }),
  }),
  success: Schema.Struct({ job: JobId }),
  failure: ToolRefusal,
}).annotateMerge(writing())

const GetJob = Tool.make('get_job', {
  description:
    'Read a job as your operator sees it: as its buyer (every proposal, the agreement, money and reviews), as a ' +
    'bidder (only your operator’s own proposals and the outcome), or the public summary otherwise. `nextAction` ' +
    'names a step only the person can take on the website, such as funding the escrow. Needs no scope.',
  parameters: Schema.Struct(onJob),
  success: Schema.Struct({ job: JobView, nextAction: Schema.NullOr(NextAction) }),
  failure: ToolRefusal,
}).annotateMerge(reading)

const Propose = Tool.make('propose', {
  description:
    'Offer terms on an open request, as your operator. The first proposal is version 1 and names no `previous`; ' +
    'to revise, name your current version as `previous`. All amounts are integer strings in the asset’s smallest ' +
    'unit (USDC has 6 decimals). Answers the proposal’s id. Needs the `propose` scope.',
  parameters: Schema.Struct({
    ...onJob,
    previous: Schema.optionalKey(ProposalVersion.annotate({ description: 'Your current version, when revising.' })),
    terms: Terms,
  }),
  success: Schema.Struct({ job: JobId, proposal: ProposalId }),
  failure: ToolRefusal,
}).annotateMerge(writing())

const RequestChange = Tool.make('request_change', {
  description:
    'As the buyer, ask a bidder to revise one exact version of their proposal (bidder, version and terms digest, as ' +
    '`get_job` shows them). Needs the `discuss` scope.',
  parameters: Schema.Struct({ ...onJob, ...ProposalRef.fields }),
  success: JobStep,
  failure: ToolRefusal,
}).annotateMerge(writing())

const Accept = Tool.make('accept', {
  description:
    'As the buyer, accept one exact version of a proposal (bidder, version and terms digest, as `get_job` shows ' +
    'them). This awards the job and declines every other bid; it cannot be undone. The person then funds the ' +
    'escrow on the website: `nextAction` links there. Needs the `accept` scope.',
  parameters: Schema.Struct({ ...onJob, ...ProposalRef.fields }),
  success: JobStep,
  failure: ToolRefusal,
}).annotateMerge(writing({ destructive: true }))

const Deliver = Tool.make('deliver', {
  description:
    'As the worker on a funded job, hand over the artifact: its SHA-256 (64 lowercase hex characters) and an ' +
    'https URL to fetch it from. The person then signs the hash onto the chain on the website: `nextAction` links ' +
    'there. Needs the `deliver` scope.',
  parameters: Schema.Struct({ ...onJob, artifactHash: Delivery.fields.artifactHash, url: Delivery.fields.url }),
  success: JobStep,
  failure: ToolRefusal,
}).annotateMerge(writing())

const LeaveReview = Tool.make('review', {
  description:
    'Review the other side of a settled job your operator was a party to: a rating from 1 to 5 and an optional ' +
    'comment, once per job. Needs the `discuss` scope.',
  parameters: Schema.Struct({ ...onJob, rating: Review.fields.rating, comment: Review.fields.comment }),
  success: JobStep,
  failure: ToolRefusal,
}).annotateMerge(writing())

const PaymentStatus = Tool.make('payment_status', {
  description:
    'Read where the job’s escrow payment stands on chain (funded, delivered, disputed or settled), as the chain ' +
    'reader verified it, for the job’s buyer or worker. `nextAction` names a step only the person can take. ' +
    'Needs no scope.',
  parameters: Schema.Struct(onJob),
  success: Schema.Struct({ payment: EscrowStatus, nextAction: Schema.NullOr(NextAction) }),
  failure: ToolRefusal,
}).annotateMerge(reading)

export const JobTools = Toolkit.make(
  ListOpenRequests,
  PostRequest,
  GetJob,
  Propose,
  RequestChange,
  Accept,
  Deliver,
  LeaveReview,
  PaymentStatus,
)
