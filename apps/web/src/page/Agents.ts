import {
  Agent,
  AgentAccessToken,
  AgentId,
  AgentToken,
  AgentTokenId,
  GrantScope,
  IssuedAgentToken,
} from '@sidequest/protocol'
import { Array, Clock, Effect, Option, Redacted, Schema } from 'effect'
import { AsyncData, Command, type Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'
import { SidequestClient } from '../Api.ts'
import { DayChoice, dayChoiceOf, editedStatus, FormStatus } from '../Forms.ts'
import { Language } from '../Language.ts'
import type { Handlers } from '../Handlers.ts'
import { Problem, problemOf } from '../Problem.ts'

// A person's agents: register one, grant it scopes until a date, issue it an MCP token (shown once), revoke either.

// MODEL

const AgentList = AsyncData.Schema(Schema.Array(Agent), Problem)
const TokenList = AsyncData.Schema(Schema.Array(AgentToken), Problem)

/** A token as it was issued, kept only while it is on screen. `Redacted` keeps the secret out of logs and DevTools. */
export const Issue = defineTaggedUnion({
  Idle: {},
  Issuing: {},
  Issued: { token: Schema.Redacted(AgentAccessToken), copied: Schema.Boolean },
  Failed: { problem: Problem },
})
export type Issue = typeof Issue.Type

/** A one-shot action such as revoking: idle, on its way, or refused. */
export const Action = defineTaggedUnion({ Idle: {}, Working: {}, Failed: { problem: Problem } })
export type Action = typeof Action.Type

/** The agent the person is managing: its grant being edited, its tokens, a token just issued. */
export const Panel = Schema.Struct({
  agent: AgentId,
  scopes: Schema.Array(GrantScope),
  days: DayChoice,
  grant: FormStatus,
  tokens: TokenList.schema,
  issue: Issue,
  revoke: Action,
})
export type Panel = typeof Panel.Type

export const Model = Schema.Struct({
  language: Language,
  agents: AgentList.schema,
  name: Schema.String,
  register: FormStatus,
  maybePanel: Schema.Option(Panel),
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  SucceededListAgents: { agents: Schema.Array(Agent) },
  FailedListAgents: { problem: Problem },
  UpdatedName: { value: Schema.String },
  SubmittedAgent: {},
  SucceededRegisterAgent: { agent: AgentId },
  FailedRegisterAgent: { problem: Problem },
  ClickedManage: { agent: AgentId },
  ClickedClose: {},
  ToggledScope: { scope: GrantScope, checked: Schema.Boolean },
  SelectedGrantDays: { value: Schema.String },
  SubmittedGrant: {},
  SucceededGrantAgent: { agent: AgentId },
  FailedGrantAgent: { agent: AgentId, problem: Problem },
  SucceededListTokens: { agent: AgentId, tokens: Schema.Array(AgentToken) },
  FailedListTokens: { agent: AgentId, problem: Problem },
  ClickedIssueToken: {},
  SucceededIssueToken: { agent: AgentId, token: IssuedAgentToken },
  FailedIssueToken: { agent: AgentId, problem: Problem },
  ClickedCopyToken: {},
  CompletedCopyToken: { copied: Schema.Boolean },
  ClickedDismissToken: {},
  ClickedRevokeToken: { token: AgentTokenId },
  SucceededRevokeToken: { agent: AgentId },
  FailedRevokeToken: { agent: AgentId, problem: Problem },
  ClickedRevokeAgent: {},
  SucceededRevokeAgent: { agent: AgentId },
  FailedRevokeAgent: { agent: AgentId, problem: Problem },
})
export type Message = typeof Message.Type

// COMMAND

const failWith =
  <M>(toMessage: (problem: Problem) => M) =>
  (error: unknown) =>
    Effect.succeed(toMessage(problemOf(error)))

export const ListAgents = Command.define('ListAgents', {
  messages: [Message.SucceededListAgents, Message.FailedListAgents],
  execute: Effect.gen(function* () {
    const api = yield* (yield* SidequestClient).api
    const page = yield* api.agents.list({ query: { limit: 50 } })
    return Message.SucceededListAgents({ agents: page.items })
  }).pipe(Effect.catch(failWith((problem) => Message.FailedListAgents({ problem })))),
})

export const RegisterAgent = Command.define('RegisterAgent', {
  args: { name: Agent.fields.name },
  messages: [Message.SucceededRegisterAgent, Message.FailedRegisterAgent],
  execute: ({ name }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      const { id } = yield* api.agents.register({ payload: { name } })
      return Message.SucceededRegisterAgent({ agent: id })
    }).pipe(Effect.catch(failWith((problem) => Message.FailedRegisterAgent({ problem })))),
})

/** Grants the scopes until `days` from now; the clock is read when the grant is sent. */
export const GrantAgent = Command.define('GrantAgent', {
  args: { agent: AgentId, scopes: Schema.NonEmptyArray(GrantScope), days: DayChoice },
  messages: [Message.SucceededGrantAgent, Message.FailedGrantAgent],
  execute: ({ agent, scopes, days }) =>
    Effect.gen(function* () {
      const now = Math.floor((yield* Clock.currentTimeMillis) / 1000)
      const api = yield* (yield* SidequestClient).api
      yield* api.agents.grant({ params: { agent }, payload: { scopes, expiresAt: now + Number(days) * 86_400 } })
      return Message.SucceededGrantAgent({ agent })
    }).pipe(Effect.catch(failWith((problem) => Message.FailedGrantAgent({ agent, problem })))),
})

export const ListTokens = Command.define('ListTokens', {
  args: { agent: AgentId },
  messages: [Message.SucceededListTokens, Message.FailedListTokens],
  execute: ({ agent }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      const page = yield* api.agents.tokens({ params: { agent }, query: { limit: 50 } })
      return Message.SucceededListTokens({ agent, tokens: page.items })
    }).pipe(Effect.catch(failWith((problem) => Message.FailedListTokens({ agent, problem })))),
})

export const IssueToken = Command.define('IssueToken', {
  args: { agent: AgentId },
  messages: [Message.SucceededIssueToken, Message.FailedIssueToken],
  execute: ({ agent }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      const token = yield* api.agents.issueToken({ params: { agent }, payload: {} })
      return Message.SucceededIssueToken({ agent, token })
    }).pipe(Effect.catch(failWith((problem) => Message.FailedIssueToken({ agent, problem })))),
})

export const RevokeToken = Command.define('RevokeToken', {
  args: { agent: AgentId, token: AgentTokenId },
  messages: [Message.SucceededRevokeToken, Message.FailedRevokeToken],
  execute: ({ agent, token }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      yield* api.agents.revokeToken({ params: { agent, token } })
      return Message.SucceededRevokeToken({ agent })
    }).pipe(Effect.catch(failWith((problem) => Message.FailedRevokeToken({ agent, problem })))),
})

export const RevokeAgent = Command.define('RevokeAgent', {
  args: { agent: AgentId },
  messages: [Message.SucceededRevokeAgent, Message.FailedRevokeAgent],
  execute: ({ agent }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      yield* api.agents.revoke({ params: { agent } })
      return Message.SucceededRevokeAgent({ agent })
    }).pipe(Effect.catch(failWith((problem) => Message.FailedRevokeAgent({ agent, problem })))),
})

/** Puts the token on the clipboard. The secret travels in the Command's argument once, as the person asked. */
export const CopyToken = Command.define('CopyToken', {
  args: { token: Schema.Redacted(AgentAccessToken) },
  messages: [Message.CompletedCopyToken],
  execute: ({ token }) =>
    Effect.tryPromise(() => navigator.clipboard.writeText(Redacted.value(token))).pipe(
      Effect.as(Message.CompletedCopyToken({ copied: true })),
      Effect.catch(() => Effect.succeed(Message.CompletedCopyToken({ copied: false }))),
    ),
})

// INIT

type UpdateReturn = Update.Return<Model, Message, SidequestClient>

/** The agents the server read, or a read of them when the person may be signed in. */
export const init = (
  language: Language,
  mayRead: boolean,
  maybeAgents: Option.Option<ReadonlyArray<Agent>>,
): UpdateReturn => {
  const model: Model = {
    language,
    agents: Option.match(maybeAgents, {
      onSome: (agents) => AgentList.Success({ data: agents }),
      onNone: () => (mayRead ? AsyncData.Loading() : AsyncData.Idle()),
    }),
    name: '',
    register: FormStatus.Editing(),
    maybePanel: Option.none(),
  }
  return mayRead && Option.isNone(maybeAgents) ? { model, commands: [ListAgents()] } : { model }
}

// UPDATE

const panelFor = (agent: Agent): Panel => ({
  agent: agent.id,
  scopes: agent.grant?.scopes ?? ['discuss'],
  days: '30',
  grant: FormStatus.Editing(),
  tokens: AsyncData.Loading(),
  issue: Issue.Idle(),
  revoke: Action.Idle(),
})

/** A change to the open panel, if it is still the agent the result is about. */
const onPanel = (model: Model, agent: AgentId, change: (panel: Panel) => Panel): Model =>
  modifyFields(model, {
    maybePanel: Option.map((panel) => (panel.agent === agent ? change(panel) : panel)),
  })

const onOpenPanel = (model: Model, change: (panel: Panel) => Panel): Model =>
  modifyFields(model, { maybePanel: Option.map(change) })

const relist = (model: Model): UpdateReturn => ({
  model: modifyFields(model, {
    agents: (agents) => Option.getOrElse(AsyncData.revalidateOrLoad(agents), () => agents),
  }),
  commands: [ListAgents()],
})

const registerAgent = (model: Model): UpdateReturn =>
  Option.match(Schema.decodeUnknownOption(Agent.fields.name)(model.name.trim()), {
    onNone: () => ({ model: modifyFields(model, { register: () => FormStatus.Invalid() }) }),
    onSome: (name) => ({
      model: modifyFields(model, { register: () => FormStatus.Submitting() }),
      commands: [RegisterAgent({ name })],
    }),
  })

const grantAgent = (model: Model): UpdateReturn =>
  Option.match(model.maybePanel, {
    onNone: () => ({ model }),
    onSome: (panel) =>
      Array.match(panel.scopes, {
        onEmpty: () => ({
          model: onOpenPanel(model, (open) => modifyFields(open, { grant: () => FormStatus.Invalid() })),
        }),
        onNonEmpty: (scopes) => ({
          model: onOpenPanel(model, (open) => modifyFields(open, { grant: () => FormStatus.Submitting() })),
          commands: [GrantAgent({ agent: panel.agent, scopes, days: panel.days })],
        }),
      }),
  })

/** Sends a Command about the open panel's agent, marking the panel as `change` says. */
const onAgent = (
  model: Model,
  change: (panel: Panel) => Panel,
  command: (agent: AgentId) => Command.Command<Message, never, SidequestClient>,
): UpdateReturn =>
  Option.match(model.maybePanel, {
    onNone: () => ({ model }),
    onSome: (panel) => ({ model: onOpenPanel(model, change), commands: [command(panel.agent)] }),
  })

const toggled = (scopes: ReadonlyArray<GrantScope>, scope: GrantScope, checked: boolean) =>
  checked ? Array.dedupe(Array.append(scopes, scope)) : Array.filter(scopes, (kept) => kept !== scope)

type Group = Partial<Handlers<Message, UpdateReturn>>

const agentHandlers = (model: Model) =>
  ({
    SucceededListAgents: ({ agents }) => ({
      model: modifyFields(model, { agents: () => AgentList.Success({ data: agents }) }),
    }),
    FailedListAgents: ({ problem }) => ({
      model: modifyFields(model, { agents: () => AgentList.Failure({ error: problem }) }),
    }),
    UpdatedName: ({ value }) => ({ model: modifyFields(model, { name: () => value, register: editedStatus }) }),
    SubmittedAgent: () => (FormStatus.guards.Submitting(model.register) ? { model } : registerAgent(model)),
    SucceededRegisterAgent: () => relist(modifyFields(model, { name: () => '', register: () => FormStatus.Editing() })),
    FailedRegisterAgent: ({ problem }) => ({
      model: modifyFields(model, { register: () => FormStatus.Failed({ problem }) }),
    }),
    ClickedManage: ({ agent }) =>
      Option.match(
        Option.flatMap(AsyncData.getData(model.agents), (agents) => Array.findFirst(agents, (one) => one.id === agent)),
        {
          onNone: () => ({ model }),
          onSome: (found) => ({
            model: modifyFields(model, { maybePanel: () => Option.some(panelFor(found)) }),
            commands: [ListTokens({ agent })],
          }),
        },
      ),
    ClickedClose: () => ({ model: modifyFields(model, { maybePanel: () => Option.none() }) }),
  }) satisfies Group

const grantHandlers = (model: Model) =>
  ({
    ToggledScope: ({ scope, checked }) => ({
      model: onOpenPanel(model, (panel) =>
        modifyFields(panel, { scopes: (scopes) => toggled(scopes, scope, checked), grant: editedStatus }),
      ),
    }),
    SelectedGrantDays: ({ value }) =>
      Option.match(dayChoiceOf(value), {
        onNone: () => ({ model }),
        onSome: (days) => ({ model: onOpenPanel(model, (panel) => modifyFields(panel, { days: () => days })) }),
      }),
    SubmittedGrant: () => grantAgent(model),
    SucceededGrantAgent: ({ agent }) =>
      relist(onPanel(model, agent, (panel) => modifyFields(panel, { grant: () => FormStatus.Editing() }))),
    FailedGrantAgent: ({ agent, problem }) => ({
      model: onPanel(model, agent, (panel) => modifyFields(panel, { grant: () => FormStatus.Failed({ problem }) })),
    }),
    ClickedRevokeAgent: () =>
      onAgent(
        model,
        (panel) => modifyFields(panel, { revoke: () => Action.Working() }),
        (agent) => RevokeAgent({ agent }),
      ),
    SucceededRevokeAgent: ({ agent }) =>
      relist(onPanel(model, agent, (panel) => modifyFields(panel, { revoke: () => Action.Idle() }))),
    FailedRevokeAgent: ({ agent, problem }) => ({
      model: onPanel(model, agent, (panel) => modifyFields(panel, { revoke: () => Action.Failed({ problem }) })),
    }),
  }) satisfies Group

const issuedToken = (model: Model) =>
  Option.flatMap(model.maybePanel, (panel) =>
    Issue.guards.Issued(panel.issue) ? Option.some(panel.issue.token) : Option.none(),
  )

const tokenHandlers = (model: Model) =>
  ({
    SucceededListTokens: ({ agent, tokens }) => ({
      model: onPanel(model, agent, (panel) =>
        modifyFields(panel, { tokens: () => TokenList.Success({ data: tokens }) }),
      ),
    }),
    FailedListTokens: ({ agent, problem }) => ({
      model: onPanel(model, agent, (panel) =>
        modifyFields(panel, { tokens: () => TokenList.Failure({ error: problem }) }),
      ),
    }),
    ClickedIssueToken: () =>
      onAgent(
        model,
        (panel) => modifyFields(panel, { issue: () => Issue.Issuing() }),
        (agent) => IssueToken({ agent }),
      ),
    SucceededIssueToken: ({ agent, token }) => ({
      model: onPanel(model, agent, (panel) =>
        modifyFields(panel, { issue: () => Issue.Issued({ token: Redacted.make(token.token), copied: false }) }),
      ),
      commands: [ListTokens({ agent })],
    }),
    FailedIssueToken: ({ agent, problem }) => ({
      model: onPanel(model, agent, (panel) => modifyFields(panel, { issue: () => Issue.Failed({ problem }) })),
    }),
    ClickedCopyToken: () =>
      Option.match(issuedToken(model), {
        onNone: () => ({ model }),
        onSome: (token) => ({ model, commands: [CopyToken({ token })] }),
      }),
    CompletedCopyToken: ({ copied }) => ({
      model: onOpenPanel(model, (panel) =>
        modifyFields(panel, {
          issue: (issue) => (Issue.guards.Issued(issue) ? Issue.Issued({ token: issue.token, copied }) : issue),
        }),
      ),
    }),
    ClickedDismissToken: () => ({
      model: onOpenPanel(model, (panel) => modifyFields(panel, { issue: () => Issue.Idle() })),
    }),
    ClickedRevokeToken: ({ token }) =>
      onAgent(
        model,
        (panel) => panel,
        (agent) => RevokeToken({ agent, token }),
      ),
    SucceededRevokeToken: ({ agent }) => ({ model, commands: [ListTokens({ agent })] }),
    FailedRevokeToken: ({ agent, problem }) => ({
      model: onPanel(model, agent, (panel) => modifyFields(panel, { revoke: () => Action.Failed({ problem }) })),
    }),
  }) satisfies Group

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, { ...agentHandlers(model), ...grantHandlers(model), ...tokenHandlers(model) })
