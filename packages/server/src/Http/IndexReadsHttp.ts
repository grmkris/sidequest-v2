import { NotIndexed } from '@sidequest/protocol'
import { Effect, Option } from 'effect'
import { HttpApiBuilder } from 'effect/http-api'
import { Jobs } from '../Index/Jobs.ts'
import { labelled, Moderation } from '../Index/Moderation.ts'
import { publicFor } from './EventsHttp.ts'
import { ServedApi } from '@sidequest/fold/api'

/**
 * The index's job reads: a job folded from what the index holds, and the open requests. Public; a
 * job changes with every event and chain fact, so caches keep an answer for seconds only.
 */
export const indexJobsHandlers = HttpApiBuilder.group(ServedApi, 'indexJobs', (handlers) =>
  Effect.gen(function* () {
    const jobs = yield* Jobs
    const moderation = yield* Moderation
    return handlers
      .handle('job', ({ params }) =>
        Effect.gen(function* () {
          const job = yield* jobs.job(params.id)
          if (Option.isNone(job)) return yield* new NotIndexed()
          yield* labelled(yield* moderation.covers([params.id, job.value.buyer]))
          yield* publicFor(10)
          return job.value
        }),
      )
      .handle('openJobs', ({ query }) =>
        Effect.gen(function* () {
          const page = yield* jobs.open({
            hideExpired: query.expired === 'exclude',
            limit: query.limit,
            cursor: query.cursor,
          })
          yield* publicFor(10)
          return page
        }),
      )
  }),
)
