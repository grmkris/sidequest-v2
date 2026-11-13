import { EventId, PublicKey } from '@sidequest/nostr'
import { JobRequestContent } from '@sidequest/nostr/vocabulary'
import {
  BadCursor,
  Hex32,
  NotIndexed,
  Page,
  PageQuery,
  SidequestApi,
  Unavailable,
  UnixSeconds,
} from '@sidequest/protocol'
import { Schema } from 'effect'
import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api'
import { JobView } from '../JobView.ts'

/**
 * An open request as the list shows it: not funded (no `JobFunded` names it) and not closed by its buyer (no
 * `withdraw_request` of theirs), the fold's rule for its pre-funding stages `open`, `proposed` and `accepted`.
 * `expired` is a label, `now` at or past its `expiresAt`; `proposals` counts the proposals for it, up to the index's
 * cap.
 */
export const OpenJob = Schema.Struct({
  job: EventId,
  buyer: PublicKey,
  createdAt: UnixSeconds,
  request: JobRequestContent,
  expired: Schema.Boolean,
  proposals: Schema.Int,
})
export type OpenJob = typeof OpenJob.Type

/**
 * The index's jobs, public like the rest of the index: one job folded from its signed events and the
 * chain's facts (`JobView`), and the open requests, newest first, optionally without the expired.
 *
 * This group lives with the fold, not in `@sidequest/protocol` beside the `events` group, because its answer is the
 * fold's schema and the protocol may depend on nothing (the fold depends on it). It is browser-safe, so the website's
 * typed client reads it exactly as the server serves it.
 */
export class IndexJobsApi extends HttpApiGroup.make('indexJobs').add(
  HttpApiEndpoint.get('job', '/api/index/jobs/:id', {
    params: { id: Hex32 },
    success: JobView,
    error: [NotIndexed, Unavailable],
  }),
  HttpApiEndpoint.get('openJobs', '/api/index/jobs', {
    query: {
      stage: Schema.Literal('open'),
      expired: Schema.optional(Schema.Literals(['include', 'exclude'])),
      ...PageQuery,
    },
    success: Page(OpenJob),
    error: [BadCursor, Unavailable],
  }),
) {}

/** The API the Worker serves and the website calls: `SidequestApi` and the index's jobs. */
export class ServedApi extends SidequestApi.add(IndexJobsApi) {}
