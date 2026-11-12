import type { JobId, JobView, NextAction, NotSignedIn } from '@sidequest/protocol'
import { Effect } from 'effect'
import { actingAs, type People, type PeopleClients } from '../../Http/People.ts'
import type { ModelError } from '../../Http/Refusals.ts'
import type { Caller } from '../McpCaller.ts'

/**
 * A call into the model as a caller the bearer token let in, which the model trusts as it was given: finding no
 * session cannot happen, so it is a defect.
 */
export const trusted = <A, E, R>(call: Effect.Effect<A, E | NotSignedIn, R>) =>
  Effect.catchTag(call, 'NotSignedIn', (error) => Effect.die(error))

/**
 * The model as the calling agent, for one tool call: the same in-process Api client as HTTP, with the agent and its
 * grant as the party, so every `decide` and `validate` judges the agent. Refusals answer as the HTTP API's errors.
 */
export const asAgent = (clients: PeopleClients['Service'], caller: Caller) => {
  const model = actingAs(clients, caller.actor)
  const ask = <A, E extends ModelError, R>(use: (people: People) => Effect.Effect<A, E, R>) => trusted(model.ask(use))
  const send = <E extends ModelError, R>(use: (people: People) => Effect.Effect<unknown, E, R>) =>
    trusted(model.send(use))
  return { ask, send }
}

/** The job's page on this site, where the person takes the steps an agent may not. */
const jobPage = (caller: Caller, job: JobId) => `${caller.origin}/jobs/${job}`

const steps = {
  fund_escrow: 'The buyer funds the escrow from their wallet on the job’s page. Agents never pay.',
  sign_delivery: 'The worker signs the delivery’s hash onto the chain from their wallet on the job’s page.',
  review_delivery: 'The buyer approves the delivery, or rejects it with a reason, from their wallet on the job’s page.',
} as const satisfies Record<NextAction['kind'], string>

/** A step only the person can take, on the job's page. */
export const nextAction = (caller: Caller, job: JobId, kind: NextAction['kind']): NextAction => ({
  kind,
  actor: 'person',
  url: jobPage(caller, job),
  description: steps[kind],
})

/** What the buyer must do next for a job as they see it: fund an award, or review a delivery. */
export const buyerStep = (caller: Caller, job: JobId, shown: JobView): NextAction | null => {
  if (shown.audience !== 'buyer') return null
  if (shown.view.state === 'Awarded') return nextAction(caller, job, 'fund_escrow')
  if (shown.view.state === 'Delivered') return nextAction(caller, job, 'review_delivery')
  return null
}
