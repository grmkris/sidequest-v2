import { Agent, AgentId, ConnectRequest, ConnectRequestId } from '@sidequest/protocol'
import { Effect, Option, Schema } from 'effect'
import { AsyncData, Command, type Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { load } from 'foldkit/navigation'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'
import { SidequestClient } from '../Api.ts'
import type { Handlers } from '../Handlers.ts'
import { Language } from '../Language.ts'
import { failedWith, Problem } from '../Problem.ts'

// An MCP client asks to act as one of the person's agents (OAuth): the person reads who asks and where the access
// goes, picks an agent of theirs, and allows or refuses. Either answer sends the browser back to the client.

// MODEL

/** The client's request: being read, no longer waiting (decided, expired, or opened in another browser), or shown. */
export const Asking = defineTaggedUnion({
  Reading: {},
  Gone: {},
  Failed: { problem: Problem },
  Shown: { request: ConnectRequest },
})
export type Asking = typeof Asking.Type

/** The person's answer: not given yet, on its way, refused by the server, or given (the browser is leaving). */
export const Answer = defineTaggedUnion({ Open: {}, Sending: {}, Failed: { problem: Problem }, Sent: {} })
export type Answer = typeof Answer.Type

const AgentList = AsyncData.Schema(Schema.Array(Agent), Problem)

export const Model = Schema.Struct({
  language: Language,
  request: ConnectRequestId,
  asking: Asking,
  agents: AgentList.schema,
  maybeAgent: Schema.Option(AgentId),
  answer: Answer,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  SucceededReadRequest: { request: ConnectRequest },
  FoundRequestGone: {},
  FailedReadRequest: { problem: Problem },
  SucceededListAgents: { agents: Schema.Array(Agent) },
  FailedListAgents: { problem: Problem },
  PickedAgent: { agent: AgentId },
  ClickedAllow: {},
  ClickedRefuse: {},
  SucceededAnswer: { redirect: Schema.String },
  FoundAnswerGone: {},
  FailedAnswer: { problem: Problem },
  CompletedLeave: {},
})
export type Message = typeof Message.Type

// COMMAND

export const ReadRequest = Command.define('ReadRequest', {
  args: { request: ConnectRequestId },
  messages: [Message.SucceededReadRequest, Message.FoundRequestGone, Message.FailedReadRequest],
  execute: ({ request }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      return Message.SucceededReadRequest({ request: yield* api.connect.request({ params: { request } }) })
    }).pipe(
      Effect.catchTag('ConnectRequestGone', () => Effect.succeed(Message.FoundRequestGone())),
      Effect.catch(failedWith(Message.FailedReadRequest)),
    ),
})

export const ListConnectAgents = Command.define('ListConnectAgents', {
  messages: [Message.SucceededListAgents, Message.FailedListAgents],
  execute: Effect.gen(function* () {
    const api = yield* (yield* SidequestClient).api
    const page = yield* api.agents.list({ query: { limit: 50 } })
    return Message.SucceededListAgents({ agents: page.items })
  }).pipe(Effect.catch(failedWith(Message.FailedListAgents))),
})

/** Allows the client to act as `agent`, or refuses it when there is none. */
export const AnswerRequest = Command.define('AnswerRequest', {
  args: { request: ConnectRequestId, maybeAgent: Schema.Option(AgentId) },
  messages: [Message.SucceededAnswer, Message.FoundAnswerGone, Message.FailedAnswer],
  execute: ({ request, maybeAgent }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      const { redirect } = yield* Option.match(maybeAgent, {
        onNone: () => api.connect.refuse({ params: { request } }),
        onSome: (agent) => api.connect.allow({ params: { request }, payload: { agent } }),
      })
      return Message.SucceededAnswer({ redirect })
    }).pipe(
      Effect.catchTag('ConnectRequestGone', () => Effect.succeed(Message.FoundAnswerGone())),
      Effect.catch(failedWith(Message.FailedAnswer)),
    ),
})

/** The browser goes back to the client, with the code or the refusal in the address. */
export const LeaveForClient = Command.define('LeaveForClient', {
  args: { href: Schema.String },
  messages: [Message.CompletedLeave],
  execute: ({ href }) => load(href).pipe(Effect.as(Message.CompletedLeave())),
})

// INIT

type UpdateReturn = Update.Return<Model, Message, SidequestClient>

export const init = (language: Language, request: ConnectRequestId, mayRead: boolean): UpdateReturn => {
  const model: Model = {
    language,
    request,
    asking: Asking.Reading(),
    agents: mayRead ? AsyncData.Loading() : AsyncData.Idle(),
    maybeAgent: Option.none(),
    answer: Answer.Open(),
  }
  return mayRead ? { model, commands: [ReadRequest({ request }), ListConnectAgents()] } : { model }
}

// UPDATE

/** Whether an agent can be picked: not revoked, with a grant that has not ended by `now` (Unix seconds). */
export const pickable = (agent: Agent, now: number): boolean =>
  !agent.revoked && agent.grant !== undefined && agent.grant.expiresAt > now

const answer = (model: Model, maybeAgent: Option.Option<AgentId>): UpdateReturn =>
  Answer.guards.Open(model.answer) || Answer.guards.Failed(model.answer)
    ? {
        model: modifyFields(model, { answer: () => Answer.Sending() }),
        commands: [AnswerRequest({ request: model.request, maybeAgent })],
      }
    : { model }

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    SucceededReadRequest: ({ request }) => ({
      model: modifyFields(model, { asking: () => Asking.Shown({ request }) }),
    }),
    FoundRequestGone: () => ({ model: modifyFields(model, { asking: () => Asking.Gone() }) }),
    FailedReadRequest: ({ problem }) => ({ model: modifyFields(model, { asking: () => Asking.Failed({ problem }) }) }),
    SucceededListAgents: ({ agents }) => ({
      model: modifyFields(model, { agents: () => AgentList.Success({ data: agents }) }),
    }),
    FailedListAgents: ({ problem }) => ({
      model: modifyFields(model, { agents: () => AgentList.Failure({ error: problem }) }),
    }),
    PickedAgent: ({ agent }) => ({ model: modifyFields(model, { maybeAgent: () => Option.some(agent) }) }),
    ClickedAllow: () => (Option.isSome(model.maybeAgent) ? answer(model, model.maybeAgent) : { model }),
    ClickedRefuse: () => answer(model, Option.none()),
    SucceededAnswer: ({ redirect }) => ({
      model: modifyFields(model, { answer: () => Answer.Sent() }),
      commands: [LeaveForClient({ href: redirect })],
    }),
    FoundAnswerGone: () => ({
      model: modifyFields(model, { asking: () => Asking.Gone(), answer: () => Answer.Open() }),
    }),
    FailedAnswer: ({ problem }) => ({ model: modifyFields(model, { answer: () => Answer.Failed({ problem }) }) }),
    CompletedLeave: () => ({ model }),
  } satisfies Handlers<Message, UpdateReturn>)
