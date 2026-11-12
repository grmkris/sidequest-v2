import { generateId, JobTools } from '@sidequest/protocol'
import { Effect } from 'effect'
import { jobViewFor } from '../../Http/JobAudience.ts'
import { paymentStatus } from '../../Http/PaymentStatus.ts'
import { PeopleClients } from '../../Http/People.ts'
import { OpenRequestReads } from '../../Reads/OpenRequestReads.ts'
import { currentCaller } from '../McpCaller.ts'
import { asAgent, buyerStep, nextAction, trusted } from './AsAgent.ts'

/**
 * The hire's tools, each the same command or read as its HTTP endpoint, sent as the calling agent: the model's
 * `decide` judges the agent's role, grant and scope, so no rule lives here. Steps for the person come back as a
 * `nextAction` on the job's page.
 */
export const JobHandlers = JobTools.toLayer(
  Effect.gen(function* () {
    const openRequests = yield* OpenRequestReads
    const clients = yield* PeopleClients
    const statusFor = yield* paymentStatus
    const model = Effect.map(currentCaller, (caller) => ({ caller, agent: asAgent(clients, caller) }))
    return JobTools.of({
      list_open_requests: ({ limit, cursor }) => openRequests.page({ limit, cursor }),
      post_request: (request) =>
        Effect.gen(function* () {
          const { agent } = yield* model
          const job = yield* generateId('JobId')
          yield* agent.send((people) => people.PostRequest({ target: job, ...request }))
          return { job }
        }),
      get_job: ({ job }) =>
        Effect.gen(function* () {
          const { caller } = yield* model
          const shown = yield* trusted(jobViewFor(clients, job, caller.actor))
          return { job: shown, nextAction: buyerStep(caller, job, shown) }
        }),
      propose: ({ job, ...offer }) =>
        Effect.gen(function* () {
          const { agent } = yield* model
          const proposal = yield* generateId('ProposalId')
          yield* agent.send((people) => people.SubmitProposal({ target: job, proposal, ...offer }))
          return { job, proposal }
        }),
      request_change: ({ job, ...named }) =>
        Effect.gen(function* () {
          const { agent } = yield* model
          yield* agent.send((people) => people.RequestChange({ target: job, ...named }))
          return { job, nextAction: null }
        }),
      accept: ({ job, ...named }) =>
        Effect.gen(function* () {
          const { caller, agent } = yield* model
          yield* agent.send((people) => people.AcceptProposal({ target: job, ...named }))
          return { job, nextAction: nextAction(caller, job, 'fund_escrow') }
        }),
      deliver: ({ job, ...delivery }) =>
        Effect.gen(function* () {
          const { caller, agent } = yield* model
          yield* agent.send((people) => people.SubmitDelivery({ target: job, ...delivery }))
          return { job, nextAction: nextAction(caller, job, 'sign_delivery') }
        }),
      review: ({ job, ...review }) =>
        Effect.gen(function* () {
          const { agent } = yield* model
          yield* agent.send((people) => people.LeaveReview({ target: job, ...review }))
          return { job, nextAction: null }
        }),
      payment_status: ({ job }) =>
        Effect.gen(function* () {
          const { caller } = yield* model
          const { agreement, status } = yield* statusFor(job, caller.actor.account)
          const buyer = agreement.buyer === caller.actor.account
          const step =
            buyer && status.stage === 'Unfunded'
              ? nextAction(caller, job, 'fund_escrow')
              : buyer && status.stage === 'Delivered'
                ? nextAction(caller, job, 'review_delivery')
                : null
          return { payment: status, nextAction: step }
        }),
    })
  }),
)
