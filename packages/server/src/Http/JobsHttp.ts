import { generateId, SidequestApi } from '@sidequest/protocol'
import { Effect } from 'effect'
import { HttpApiBuilder } from 'effect/http-api'
import { OpenRequestReads } from '../Reads/OpenRequestReads.ts'
import { jobViewFor } from './JobAudience.ts'
import { PeopleClients, signedIn } from './People.ts'
import { visitorOf } from './SignedInLive.ts'
import { Sessions } from '../SignIn/Sessions.ts'

/**
 * The `jobs` group: each command goes to the job as the signed-in person, under ids the server mints; the open
 * requests come from D1, and one job is read as whoever asks.
 */
export const jobsHandlers = HttpApiBuilder.group(SidequestApi, 'jobs', (handlers) =>
  Effect.gen(function* () {
    const openRequests = yield* OpenRequestReads
    const sessions = yield* Sessions
    const clients = yield* PeopleClients
    const asPerson = signedIn(clients)
    return handlers
      .handle('post', ({ payload }) =>
        Effect.gen(function* () {
          const id = yield* generateId('JobId')
          yield* asPerson.ask((people) => people.PostRequest({ target: id, ...payload }))
          return { id }
        }),
      )
      .handle('open', ({ query }) => openRequests.page(query))
      .handle('get', ({ params, request }) =>
        Effect.flatMap(visitorOf(sessions, request), (account) => jobViewFor(clients, params.job, account)),
      )
      .handle('propose', ({ params, payload }) =>
        Effect.gen(function* () {
          const id = yield* generateId('ProposalId')
          yield* asPerson.ask((people) => people.SubmitProposal({ target: params.job, proposal: id, ...payload }))
          return { id }
        }),
      )
      .handle('requestChange', ({ params, payload }) =>
        asPerson.send((people) => people.RequestChange({ target: params.job, ...payload })),
      )
      .handle('accept', ({ params, payload }) =>
        asPerson.send((people) => people.AcceptProposal({ target: params.job, ...payload })),
      )
      .handle('cancel', ({ params }) => asPerson.send((people) => people.CancelRequest({ target: params.job })))
      .handle('deliver', ({ params, payload }) =>
        asPerson.send((people) => people.SubmitDelivery({ target: params.job, ...payload })),
      )
      .handle('approve', ({ params }) => asPerson.send((people) => people.ApproveDelivery({ target: params.job })))
      .handle('reject', ({ params, payload }) =>
        asPerson.send((people) => people.RejectDelivery({ target: params.job, ...payload })),
      )
      .handle('review', ({ params, payload }) =>
        asPerson.send((people) => people.LeaveReview({ target: params.job, ...payload })),
      )
  }),
)
