import * as Domain from '@alchemy.run/domain'
import { DateTime, Effect } from 'effect'
import { system } from '../Actor.ts'
import { CurrentActor } from '../CurrentActor.context.ts'
import { ExpireRequest } from './ExpireRequest.command.ts'
import { Job } from './Job.aggregate.ts'
import { RequestPosted } from './PostRequest.command.ts'

/**
 * A posted request expires at its `expiresAt`: the system schedules {@link ExpireRequest}, which never rejects, so it
 * can be scheduled. If the job was awarded or cancelled first, the command records nothing when it fires.
 */
export class RequestExpiry extends Domain.Policy('RequestExpiry', { from: Job, on: [RequestPosted] }) {}

export const RequestExpiryLive = RequestExpiry.toLayer(
  Effect.gen(function* () {
    const jobs = yield* Job
    return ({ source, event }) =>
      jobs
        .schedule(source, new ExpireRequest(), { at: DateTime.makeUnsafe(event.request.expiresAt * 1000) })
        .pipe(Effect.provideService(CurrentActor, system('RequestExpiry')))
  }),
)
