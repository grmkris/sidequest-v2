import { JobView } from '@sidequest/fold'
import { BadCursor, Hex32, NotIndexed, Page, PageQuery, SidequestApi, Unavailable } from '@sidequest/protocol'
import { Schema } from 'effect'
import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api'
import { OpenJob } from '../Index/Jobs.ts'

/**
 * The index's jobs, public and sessionless like the rest of the index: one job folded from its signed events and the
 * chain's facts (`@sidequest/fold`'s `JobView`), and the open requests, newest first, optionally without the expired.
 *
 * This group lives with the server, not in `@sidequest/protocol` beside the `events` group, because its answer is the
 * fold's schema and the protocol may depend on nothing (`@sidequest/fold` depends on it). It is added to
 * `SidequestApi` after its `SameOrigin` middleware, exactly as `events` is, so that middleware never runs here.
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

/** The API the Worker serves: `SidequestApi` and the index's jobs. */
export class ServedApi extends SidequestApi.add(IndexJobsApi) {}
