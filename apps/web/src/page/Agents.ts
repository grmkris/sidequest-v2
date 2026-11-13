import { AgentGrantView, GrantScope } from '@sidequest/protocol'
import { Array, Effect, Option, Order, Schema } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import { AsyncData, Command, Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'
import { SidequestClient } from '../Api.ts'
import { DayChoice, dayChoiceOf } from '../Forms.ts'
import { Gateway, GatewayRefusal, GatewayRefused } from '../Gateway.ts'
import type { Handlers } from '../Handlers.ts'
import { Language } from '../Language.ts'
import { Me, pubkeyOf } from '../Me.ts'
import { failedWith, Problem } from '../Problem.ts'
import { PublishFailure, PublishRefusal, publishEvent, publishFailureOf } from '../Publishing.ts'
import { SignerFailure, type Signers } from '../Signer.ts'
import type { Wallet } from '../Wallet.ts'
import * as Delegation from './Delegation.ts'

// A person's agents at the stage's agent gateway (apps/gateway): the gateway makes each agent's key and keeps it
// sealed; the person's key grants it scopes until a date with a signed event published through the index, and may
// revoke that grant, pause the agent's rooms, or delete it. Every gateway call carries a NIP-98 authorization the
// person's signer makes (`Gateway.ts`); the grants are read from the index, never from the gateway.

// MODEL

/** An agent as the gateway lists it for its operator. */
export const AgentEntry = Schema.Struct({
  agent: Schema.String,
  label: Schema.String,
  createdAt: Schema.Int,
  paused: Schema.Boolean,
  connections: Schema.Int,
})
export type AgentEntry = typeof AgentEntry.Type

/** Why an act did not happen: the gateway refused it, the index refused the event, the signer could not sign, or
 * another problem. */
export const AgentsFailure = defineTaggedUnion({
  Gateway: { refusal: GatewayRefusal },
  Index: { refusal: PublishRefusal },
  SignerFailed: { reason: SignerFailure },
  Failed: { problem: Problem },
})
export type AgentsFailure = typeof AgentsFailure.Type

/** Any error of an act on the agents page as an {@link AgentsFailure}. */
export const agentsFailureOf = (error: unknown): AgentsFailure => {
  if (error instanceof GatewayRefused) {
    return AgentsFailure.Gateway({ refusal: error.refusal })
  }
  return PublishFailure.match(publishFailureOf(error), {
    Refused: ({ refusal }) => AgentsFailure.Index({ refusal }),
    SignerFailed: ({ reason }) => AgentsFailure.SignerFailed({ reason }),
    Failed: ({ problem }) => AgentsFailure.Failed({ problem }),
  })
}

const AgentsData = AsyncData.Schema(Schema.Array(AgentEntry), AgentsFailure)
const GrantsData = AsyncData.Schema(Schema.Array(AgentGrantView), Problem)

/** What the person does to their agents. */
export const Act = Schema.Literals(['create', 'grant', 'revoke', 'pause', 'resume', 'delete'])
export type Act = typeof Act.Type

/** One act at a time: confirming a deletion, on its way, done, or refused. `maybeAgent` is none for an agent still
 * being made. */
export const Action = defineTaggedUnion({
  Idle: {},
  ConfirmingDelete: { agent: Schema.String },
  Working: { maybeAgent: Schema.Option(Schema.String), act: Act },
  Done: { maybeAgent: Schema.Option(Schema.String), act: Act },
  Failed: { maybeAgent: Schema.Option(Schema.String), act: Act, failure: AgentsFailure },
})
export type Action = typeof Action.Type

/** What a grant lets the agent do and for how long. */
export const GrantChoice = Schema.Struct({ scopes: Schema.Array(GrantScope), days: DayChoice })
export type GrantChoice = typeof GrantChoice.Type

/** A new agent: its label and its first grant; `invalid` once a submission found it wanting. */
export const Draft = Schema.Struct({ label: Schema.String, grant: GrantChoice, invalid: Schema.Boolean })
export type Draft = typeof Draft.Type

/** The agent being managed, with the grant to give it again. */
export const Panel = Schema.Struct({ agent: Schema.String, grant: GrantChoice })
export type Panel = typeof Panel.Type

export const Model = Schema.Struct({
  language: Language,
  me: Me,
  /** The stage's gateway, whose MCP endpoint the page shows; none when the stage has none. */
  maybeGatewayUrl: Schema.Option(Schema.String),
  maybeReadFor: Schema.Option(Schema.String),
  agents: AgentsData.schema,
  grants: GrantsData.schema,
  draft: Draft,
  maybePanel: Schema.Option(Panel),
  action: Action,
  delegation: Delegation.Model,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  SucceededListAgents: { pubkey: Schema.String, agents: Schema.Array(AgentEntry) },
  FailedListAgents: { pubkey: Schema.String, failure: AgentsFailure },
  SucceededReadGrants: { pubkey: Schema.String, grants: Schema.Array(AgentGrantView) },
  FailedReadGrants: { pubkey: Schema.String, problem: Problem },
  UpdatedLabel: { value: Schema.String },
  ToggledScope: { scope: GrantScope, checked: Schema.Boolean },
  SelectedDays: { value: Schema.String },
  SubmittedCreate: {},
  SucceededCreateAgent: { agent: Schema.String, label: Schema.String, grant: GrantChoice },
  SucceededAct: { agent: Schema.String, act: Act },
  FailedAct: { maybeAgent: Schema.Option(Schema.String), act: Act, failure: AgentsFailure },
  ClickedManage: { agent: Schema.String },
  ClickedClosePanel: {},
  ToggledPanelScope: { scope: GrantScope, checked: Schema.Boolean },
  SelectedPanelDays: { value: Schema.String },
  SubmittedGrant: {},
  ClickedRevoke: { agent: Schema.String, grant: Schema.String },
  ClickedPause: { agent: Schema.String },
  ClickedResume: { agent: Schema.String },
  ClickedDelete: { agent: Schema.String },
  ClickedConfirmDelete: {},
  ClickedKeep: {},
  GotDelegationMessage: { message: Delegation.Message },
})
export type Message = typeof Message.Type

// COMMAND

const Listed = Schema.Struct({ items: Schema.Array(AgentEntry) })
const Created = Schema.Struct({ agent: Schema.String })
const decodeOr =
  <A>(schema: Schema.Decoder<A>) =>
  (body: unknown) =>
    Effect.mapError(
      Schema.decodeUnknownEffect(schema)(body),
      () => new GatewayRefused({ refusal: GatewayRefusal.Unreachable() }),
    )

const failedAct = (maybeAgent: Option.Option<string>, act: Act) => (error: unknown) =>
  Effect.succeed(Message.FailedAct({ maybeAgent, act, failure: agentsFailureOf(error) }))

/** The person's agents at the gateway. */
export const ListAgents = Command.define('ListAgents', {
  args: { pubkey: Schema.String },
  messages: [Message.SucceededListAgents, Message.FailedListAgents],
  execute: ({ pubkey }) =>
    Gateway.use((gateway) => gateway.send('GET', '/api/agents', Option.none())).pipe(
      Effect.flatMap(decodeOr(Listed)),
      Effect.map(({ items }) => Message.SucceededListAgents({ pubkey, agents: items })),
      Effect.catch((error) => Effect.succeed(Message.FailedListAgents({ pubkey, failure: agentsFailureOf(error) }))),
    ),
})

/** The grants the person's key gave, as the index shows them now. */
export const ReadGrants = Command.define('ReadGrants', {
  args: { pubkey: Schema.String },
  messages: [Message.SucceededReadGrants, Message.FailedReadGrants],
  execute: ({ pubkey }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      const person = yield* api.events
        .person({ params: { pubkey } })
        .pipe(Effect.provideService(FetchHttpClient.RequestInit, { cache: 'no-cache' }))
      return Message.SucceededReadGrants({ pubkey, grants: person.agents })
    }).pipe(
      Effect.catchTag('NotIndexed', () => Effect.succeed(Message.SucceededReadGrants({ pubkey, grants: [] }))),
      Effect.catch(failedWith((payload) => Message.FailedReadGrants({ pubkey, ...payload }))),
    ),
})

/** The gateway makes the agent and its key, and answers its public key. */
export const CreateAgent = Command.define('CreateAgent', {
  args: { label: Schema.String, grant: GrantChoice },
  messages: [Message.SucceededCreateAgent, Message.FailedAct],
  execute: ({ label, grant }) =>
    Gateway.use((gateway) => gateway.send('POST', '/api/agents', Option.some({ label }))).pipe(
      Effect.flatMap(decodeOr(Created)),
      Effect.map(({ agent }) => Message.SucceededCreateAgent({ agent, label, grant })),
      Effect.catch(failedAct(Option.none(), 'create')),
    ),
})

const day = 86_400

/** The person's key grants the agent the scopes from now until the days chosen, under the label; `act` says whether it
 * is a new agent's first grant or a later one. */
export const PublishGrant = Command.define('PublishGrant', {
  args: {
    agent: Schema.String,
    label: Schema.String,
    scopes: Schema.NonEmptyArray(GrantScope),
    days: DayChoice,
    act: Schema.Literals(['create', 'grant']),
  },
  messages: [Message.SucceededAct, Message.FailedAct],
  execute: ({ agent, label, scopes, days, act }) =>
    publishEvent((kit, createdAt) =>
      kit.grantTemplate(
        { agent, scopes, notBefore: createdAt, expiresAt: createdAt + Number(days) * day, label },
        createdAt,
      ),
    ).pipe(Effect.as(Message.SucceededAct({ agent, act })), Effect.catch(failedAct(Option.some(agent), act))),
})

/** The person's key ends one of its grants. */
export const PublishRevocation = Command.define('PublishRevocation', {
  args: { agent: Schema.String, grant: Schema.String },
  messages: [Message.SucceededAct, Message.FailedAct],
  execute: ({ agent, grant }) =>
    publishEvent((kit, createdAt) => kit.revocationTemplate(grant, createdAt)).pipe(
      Effect.as(Message.SucceededAct({ agent, act: 'revoke' })),
      Effect.catch(failedAct(Option.some(agent), 'revoke')),
    ),
})

/** The agent's rooms pause, or go on. */
export const SetPause = Command.define('SetPause', {
  args: { agent: Schema.String, paused: Schema.Boolean },
  messages: [Message.SucceededAct, Message.FailedAct],
  execute: ({ agent, paused }) => {
    const act: Act = paused ? 'pause' : 'resume'
    return Gateway.use((gateway) =>
      gateway.send(paused ? 'POST' : 'DELETE', `/api/agents/${agent}/pause`, Option.none()),
    ).pipe(Effect.as(Message.SucceededAct({ agent, act })), Effect.catch(failedAct(Option.some(agent), act)))
  },
})

/** The gateway destroys the agent's key and ends its connections and delegations. */
export const DeleteAgent = Command.define('DeleteAgent', {
  args: { agent: Schema.String },
  messages: [Message.SucceededAct, Message.FailedAct],
  execute: ({ agent }) =>
    Gateway.use((gateway) => gateway.send('DELETE', `/api/agents/${agent}`, Option.none())).pipe(
      Effect.as(Message.SucceededAct({ agent, act: 'delete' })),
      Effect.catch(failedAct(Option.some(agent), 'delete')),
    ),
})

// INIT

export type Services = SidequestClient | Gateway | Signers | Wallet
type UpdateReturn = Update.Return<Model, Message, Services>

const freshGrant: GrantChoice = { scopes: ['discuss', 'propose'], days: '30' }

/** What the page reads for `pubkey`: its agents at the gateway and its grants in the index. */
const readsFor = (model: Model, pubkey: string): UpdateReturn => ({
  model: modifyFields(model, {
    maybeReadFor: () => Option.some(pubkey),
    agents: (agents) => Option.getOrElse(AsyncData.revalidateOrLoad(agents), () => agents),
    grants: (grants) => Option.getOrElse(AsyncData.revalidateOrLoad(grants), () => grants),
  }),
  commands: [ListAgents({ pubkey }), ReadGrants({ pubkey })],
})

/** Reads once the stage has a gateway and the site knows the person's signer. */
const readIfReady = (model: Model): UpdateReturn =>
  Option.match(Option.all({ pubkey: pubkeyOf(model.me), gateway: model.maybeGatewayUrl }), {
    onNone: () => ({ model }),
    onSome: ({ pubkey }) => (Option.contains(model.maybeReadFor, pubkey) ? { model } : readsFor(model, pubkey)),
  })

export const init = (language: Language, me: Me, maybeGatewayUrl: Option.Option<string>): UpdateReturn =>
  readIfReady({
    language,
    me,
    maybeGatewayUrl,
    maybeReadFor: Option.none(),
    agents: AsyncData.Idle(),
    grants: AsyncData.Idle(),
    draft: { label: '', grant: freshGrant, invalid: false },
    maybePanel: Option.none(),
    action: Action.Idle(),
    delegation: Delegation.init(language),
  })

/** Who the person is changed: a new key's agents are read. */
export const meChanged = (model: Model, me: Me): UpdateReturn => readIfReady(modifyFields(model, { me: () => me }))

// DERIVED

/** The grant the page shows for an agent: an active one, else the latest the person gave it. */
const byNotBefore = Order.mapInput(Order.Number, (grant: AgentGrantView) => grant.notBefore)

export const grantOf = (grants: ReadonlyArray<AgentGrantView>, agent: string): Option.Option<AgentGrantView> => {
  const given = Array.filter(grants, (grant) => grant.agent === agent)
  return Option.orElse(
    Array.findFirst(given, (grant) => grant.status === 'active'),
    () => Array.last(Array.sort(given, byNotBefore)),
  )
}

const busy = (model: Model) => Action.guards.Working(model.action)

// UPDATE

const toggled = (scopes: ReadonlyArray<GrantScope>, scope: GrantScope, checked: boolean) =>
  checked ? Array.dedupe(Array.append(scopes, scope)) : Array.filter(scopes, (kept) => kept !== scope)

const withAction = (model: Model, action: Action) => modifyFields(model, { action: () => action })

/** An act on the gateway or the index, unless one is under way. */
const acting = (
  model: Model,
  maybeAgent: Option.Option<string>,
  act: Act,
  command: Command.Command<Message, never, Services>,
): UpdateReturn =>
  busy(model) ? { model } : { model: withAction(model, Action.Working({ maybeAgent, act })), commands: [command] }

/** The label trimmed, when it is one a grant and the gateway take (1 to 120 characters). */
const labelOf = (label: string): Option.Option<string> =>
  Option.liftPredicate(label.trim(), (trimmed) => trimmed.length > 0 && trimmed.length <= 120)

/** The scopes, when there is at least one. */
const nonEmpty = (scopes: ReadonlyArray<GrantScope>): Option.Option<Array.NonEmptyReadonlyArray<GrantScope>> =>
  Array.isReadonlyArrayNonEmpty(scopes) ? Option.some(scopes) : Option.none()

const submittedCreate = (model: Model): UpdateReturn => {
  const { label, grant } = model.draft
  const trimmed = labelOf(label)
  return Option.isSome(trimmed) && Option.isSome(nonEmpty(grant.scopes))
    ? acting(model, Option.none(), 'create', CreateAgent({ label: trimmed.value, grant }))
    : { model: modifyFields(model, { draft: (draft) => modifyFields(draft, { invalid: () => true }) }) }
}

/** The agent's label as the gateway lists it. */
const labelOfAgent = (model: Model, agent: string): Option.Option<string> =>
  Option.map(
    Option.flatMap(AsyncData.getData(model.agents), (agents) =>
      Array.findFirst(agents, (entry) => entry.agent === agent),
    ),
    (entry) => entry.label,
  )

const submittedGrant = (model: Model): UpdateReturn => {
  if (Option.isNone(model.maybePanel)) {
    return { model }
  }
  const panel = model.maybePanel.value
  const scopes = nonEmpty(panel.grant.scopes)
  const label = labelOfAgent(model, panel.agent)
  return Option.isSome(scopes) && Option.isSome(label)
    ? acting(
        model,
        Option.some(panel.agent),
        'grant',
        PublishGrant({
          agent: panel.agent,
          label: label.value,
          scopes: scopes.value,
          days: panel.grant.days,
          act: 'grant',
        }),
      )
    : { model }
}

/** After an act: the index's grants changed (a grant or a revocation), or the gateway's list did. */
const afterAct = (model: Model, agent: string, act: Act): UpdateReturn => {
  const done = withAction(model, Action.Done({ maybeAgent: Option.some(agent), act }))
  const changed = act === 'delete' ? modifyFields(done, { maybePanel: () => Option.none() }) : done
  return Option.match(changed.maybeReadFor, {
    onNone: () => ({ model: changed }),
    onSome: (pubkey) => ({
      model: changed,
      commands:
        act === 'grant' || act === 'revoke'
          ? [ReadGrants({ pubkey })]
          : [ListAgents({ pubkey }), ReadGrants({ pubkey })],
    }),
  })
}

const onPanel = (model: Model, change: (panel: Panel) => Panel): Model =>
  modifyFields(model, { maybePanel: Option.map(change) })

const forCurrent = (model: Model, pubkey: string, apply: () => UpdateReturn): UpdateReturn =>
  Option.contains(model.maybeReadFor, pubkey) ? apply() : { model }

type Group = Partial<Handlers<Message, UpdateReturn>>

const readHandlers = (model: Model) =>
  ({
    SucceededListAgents: ({ pubkey, agents }) =>
      forCurrent(model, pubkey, () => ({
        model: modifyFields(model, { agents: () => AgentsData.Success({ data: agents }) }),
      })),
    FailedListAgents: ({ pubkey, failure }) =>
      forCurrent(model, pubkey, () => ({
        model: modifyFields(model, { agents: () => AgentsData.Failure({ error: failure }) }),
      })),
    SucceededReadGrants: ({ pubkey, grants }) =>
      forCurrent(model, pubkey, () => ({
        model: modifyFields(model, { grants: () => GrantsData.Success({ data: grants }) }),
      })),
    FailedReadGrants: ({ pubkey, problem }) =>
      forCurrent(model, pubkey, () => ({
        model: modifyFields(model, { grants: () => GrantsData.Failure({ error: problem }) }),
      })),
  }) satisfies Group

const draftHandlers = (model: Model) =>
  ({
    UpdatedLabel: ({ value }) => ({
      model: modifyFields(model, { draft: (draft) => modifyFields(draft, { label: () => value }) }),
    }),
    ToggledScope: ({ scope, checked }) => ({
      model: modifyFields(model, {
        draft: (draft) =>
          modifyFields(draft, {
            grant: (grant) => modifyFields(grant, { scopes: (scopes) => toggled(scopes, scope, checked) }),
          }),
      }),
    }),
    SelectedDays: ({ value }) =>
      Option.match(dayChoiceOf(value), {
        onNone: () => ({ model }),
        onSome: (days) => ({
          model: modifyFields(model, {
            draft: (draft) => modifyFields(draft, { grant: (grant) => modifyFields(grant, { days: () => days }) }),
          }),
        }),
      }),
    SubmittedCreate: () => submittedCreate(model),
    SucceededCreateAgent: ({ agent, label, grant }) =>
      Array.match(grant.scopes, {
        onEmpty: () => afterAct(model, agent, 'create'),
        onNonEmpty: (scopes) => ({
          model: modifyFields(withAction(model, Action.Working({ maybeAgent: Option.some(agent), act: 'create' })), {
            draft: () => ({ label: '', grant: freshGrant, invalid: false }),
          }),
          commands: [PublishGrant({ agent, label, scopes, days: grant.days, act: 'create' })],
        }),
      }),
    SucceededAct: ({ agent, act }) => afterAct(model, agent, act),
    FailedAct: ({ maybeAgent, act, failure }) => {
      const failed = withAction(model, Action.Failed({ maybeAgent, act, failure }))
      // A new agent whose grant was refused exists without one: the list shows it, to grant again.
      return act === 'create' && Option.isSome(maybeAgent)
        ? Option.match(model.maybeReadFor, {
            onNone: () => ({ model: failed }),
            onSome: (pubkey) => ({ model: failed, commands: [ListAgents({ pubkey })] }),
          })
        : { model: failed }
    },
  }) satisfies Group

const panelHandlers = (model: Model) =>
  ({
    ClickedManage: ({ agent }) => ({
      model: modifyFields(model, {
        maybePanel: () =>
          Option.some({
            agent,
            grant: Option.match(
              Option.flatMap(AsyncData.getData(model.grants), (grants) => grantOf(grants, agent)),
              {
                onNone: () => freshGrant,
                onSome: (grant) => ({ scopes: grant.scopes, days: freshGrant.days }),
              },
            ),
          }),
        delegation: (delegation) => Delegation.closed(delegation),
      }),
    }),
    ClickedClosePanel: () => ({ model: modifyFields(model, { maybePanel: () => Option.none() }) }),
    ToggledPanelScope: ({ scope, checked }) => ({
      model: onPanel(model, (panel) =>
        modifyFields(panel, {
          grant: (grant) => modifyFields(grant, { scopes: (scopes) => toggled(scopes, scope, checked) }),
        }),
      ),
    }),
    SelectedPanelDays: ({ value }) =>
      Option.match(dayChoiceOf(value), {
        onNone: () => ({ model }),
        onSome: (days) => ({
          model: onPanel(model, (panel) =>
            modifyFields(panel, { grant: (grant) => modifyFields(grant, { days: () => days }) }),
          ),
        }),
      }),
    SubmittedGrant: () => submittedGrant(model),
    ClickedRevoke: ({ agent, grant }) =>
      acting(model, Option.some(agent), 'revoke', PublishRevocation({ agent, grant })),
    ClickedPause: ({ agent }) => acting(model, Option.some(agent), 'pause', SetPause({ agent, paused: true })),
    ClickedResume: ({ agent }) => acting(model, Option.some(agent), 'resume', SetPause({ agent, paused: false })),
    ClickedDelete: ({ agent }) =>
      busy(model) ? { model } : { model: withAction(model, Action.ConfirmingDelete({ agent })) },
    ClickedConfirmDelete: () =>
      Action.guards.ConfirmingDelete(model.action)
        ? {
            model: withAction(model, Action.Working({ maybeAgent: Option.some(model.action.agent), act: 'delete' })),
            commands: [DeleteAgent({ agent: model.action.agent })],
          }
        : { model },
    ClickedKeep: () => ({ model: withAction(model, Action.Idle()) }),
  }) satisfies Group

const foldDelegation = Update.foldChild({
  update: Delegation.update,
  read: (model: Model) => Option.some(model.delegation),
  write: (model: Model, nextDelegation: Delegation.Model) => modifyFields(model, { delegation: () => nextDelegation }),
  toParentMessage: (message) => Message.GotDelegationMessage({ message }),
})

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    ...readHandlers(model),
    ...draftHandlers(model),
    ...panelHandlers(model),
    GotDelegationMessage: ({ message: delegationMessage }) => foldDelegation(model, delegationMessage),
  })
