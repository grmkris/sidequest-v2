import { Schema } from 'effect'
import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api'
import { Delivery } from './Delivery.ts'
import { SignedIn } from './Guards.ts'
import { JobId, ProposalId } from './Id.ts'
import { JobView, ProposalRef } from './JobView.ts'
import { Page, PageQuery } from './Page.ts'
import { ProposalVersion } from './Proposal.ts'
import { BadCursor, refusals } from './Refusals.ts'
import { Review } from './Review.ts'
import { Unavailable } from './SessionApi.ts'
import { Terms } from './Terms.ts'
import { OpenRequest, WorkRequest } from './WorkRequest.ts'

const onJob = { job: JobId }

/** A command on one job, answered with no content. */
const jobCommand = { params: onJob, error: refusals }

/**
 * The hire, up to what happens on chain: post a request, list the open ones, read a job as its buyer, a bidder or
 * anyone, propose, ask for a change, accept one exact version, cancel, hand over the delivered artifact, and review.
 * The server mints job and proposal ids. Funding, the delivery's hash on chain, approval, rejection and rulings are
 * signatures, in `SettlementApi`.
 */
export class JobsApi extends HttpApiGroup.make('jobs').add(
  HttpApiEndpoint.post('post', '/api/jobs', {
    payload: Schema.Struct({
      title: WorkRequest.fields.title,
      description: WorkRequest.fields.description,
      expiresAt: WorkRequest.fields.expiresAt,
    }),
    success: Schema.Struct({ id: JobId }),
    error: refusals,
  }).middleware(SignedIn),
  HttpApiEndpoint.get('open', '/api/jobs', {
    query: PageQuery,
    success: Page(OpenRequest),
    error: [BadCursor, Unavailable],
  }),
  HttpApiEndpoint.get('get', '/api/jobs/:job', { params: onJob, success: JobView, error: [...refusals, Unavailable] }),
  HttpApiEndpoint.post('propose', '/api/jobs/:job/proposals', {
    params: onJob,
    payload: Schema.Struct({ previous: Schema.optionalKey(ProposalVersion), terms: Terms }),
    success: Schema.Struct({ id: ProposalId }),
    error: refusals,
  }).middleware(SignedIn),
  HttpApiEndpoint.post('requestChange', '/api/jobs/:job/change-requests', {
    ...jobCommand,
    payload: ProposalRef,
  }).middleware(SignedIn),
  HttpApiEndpoint.post('accept', '/api/jobs/:job/acceptance', { ...jobCommand, payload: ProposalRef }).middleware(
    SignedIn,
  ),
  HttpApiEndpoint.post('cancel', '/api/jobs/:job/cancellation', jobCommand).middleware(SignedIn),
  HttpApiEndpoint.post('deliver', '/api/jobs/:job/delivery', {
    ...jobCommand,
    payload: Schema.Struct({ artifactHash: Delivery.fields.artifactHash, url: Delivery.fields.url }),
  }).middleware(SignedIn),
  HttpApiEndpoint.post('review', '/api/jobs/:job/reviews', {
    ...jobCommand,
    payload: Schema.Struct({ rating: Review.fields.rating, comment: Review.fields.comment }),
  }).middleware(SignedIn),
) {}
