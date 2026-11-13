import { Erc8004Deployment, Erc8004Identity, Erc8004RegistrationCall, WalletAddress } from '@sidequest/protocol'
import { Array, Duration, Effect, Option, Schedule, Schema } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import { AsyncData, Command, type Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'
import { SidequestClient } from '../Api.ts'
import type { Handlers } from '../Handlers.ts'
import { Language } from '../Language.ts'
import { failedWith, Problem } from '../Problem.ts'
import { PublishFailure, publishEvent, publishFailureOf } from '../Publishing.ts'
import type { Signers } from '../Signer.ts'
import { Connection, type ReceiptLog, Wallet } from '../Wallet.ts'

// An operator's agents on ERC-8004 (ADR-0007): each agent's identities as the index verified them and its feedback in
// short, and registering one. Registering is the operator's wallet sending `register(agentURI)`, which the core
// prepares with the agent's registration file as the URI; the wallet owns the token and pays the gas. The page then
// reads the minted id from the receipt and the person's key publishes the claim that the token stands for the agent,
// which the index verifies against the chain within a minute. Nothing here moves money or authorises anything.

// MODEL

/** What the page shows of one agent: its identities and how many reviews count for it, with their mean rating. */
export const Summary = Schema.Struct({
  agent: Schema.String,
  identities: Schema.Array(Erc8004Identity),
  count: Schema.Int,
  averageRating: Schema.NullOr(Schema.Number),
})
export type Summary = typeof Summary.Type

/** Why a registration stopped: the index refused the claim, the signer could not sign it, the wallet's transaction
 * minted no token, or another problem (the wallet saying no among them). */
export const RegistrationFailure = defineTaggedUnion({
  Claim: { failure: PublishFailure },
  NotMinted: {},
  Failed: { problem: Problem },
})
export type RegistrationFailure = typeof RegistrationFailure.Type

const Registering = { agent: Schema.String, maybeMcp: Schema.Option(Schema.String) }

/** Where one registration is. */
export const Flow = defineTaggedUnion({
  Closed: {},
  Connecting: Registering,
  Preparing: { ...Registering, signer: WalletAddress },
  Sending: { ...Registering, signer: WalletAddress, call: Erc8004RegistrationCall },
  Mining: { ...Registering, registry: Schema.String, hash: Schema.String },
  Claiming: { agent: Schema.String, agentId: Schema.String },
  Claimed: { agent: Schema.String, agentId: Schema.String },
  Failed: { agent: Schema.String, failure: RegistrationFailure },
})
export type Flow = typeof Flow.Type

const DeploymentData = AsyncData.Schema(Erc8004Deployment, Problem)
const SummariesData = AsyncData.Schema(Schema.Array(Summary), Problem)

export const Model = Schema.Struct({
  language: Language,
  deployment: DeploymentData.schema,
  summaries: SummariesData.schema,
  flow: Flow,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  SucceededReadDeployment: { deployment: Erc8004Deployment },
  FailedReadDeployment: { problem: Problem },
  SucceededReadSummaries: { summaries: Schema.Array(Summary) },
  FailedReadSummaries: { problem: Problem },
  ClickedRegister: Registering,
  ClickedCloseRegistration: {},
  SucceededConnectWallet: { connection: Connection },
  FailedConnectWallet: { problem: Problem },
  SucceededPrepareRegistration: { call: Erc8004RegistrationCall },
  FailedPrepareRegistration: { problem: Problem },
  SucceededSendRegistration: { hash: Schema.String },
  FailedSendRegistration: { problem: Problem },
  SucceededAwaitRegistration: { agentId: Schema.String },
  FailedAwaitRegistration: { failure: RegistrationFailure },
  SucceededPublishClaim: {},
  FailedPublishClaim: { failure: PublishFailure },
})
export type Message = typeof Message.Type

// COMMAND

const fresh = Effect.provideService(FetchHttpClient.RequestInit, { cache: 'no-cache' })

/** The stage's registries. */
export const ReadDeployment = Command.define('ReadDeployment', {
  messages: [Message.SucceededReadDeployment, Message.FailedReadDeployment],
  execute: Effect.gen(function* () {
    const api = yield* (yield* SidequestClient).api
    return Message.SucceededReadDeployment({ deployment: yield* api.erc8004.deployment() })
  }).pipe(Effect.catch(failedWith(Message.FailedReadDeployment))),
})

/** Each agent's identities, from the index's read of the key, and its feedback file's count and mean. */
export const ReadSummaries = Command.define('ReadSummaries', {
  args: { agents: Schema.Array(Schema.String) },
  messages: [Message.SucceededReadSummaries, Message.FailedReadSummaries],
  execute: ({ agents }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      const summaries = yield* Effect.forEach(
        agents,
        (agent) =>
          Effect.gen(function* () {
            const identities = yield* api.events.person({ params: { pubkey: agent } }).pipe(
              fresh,
              Effect.map((person) => person.erc8004),
              Effect.catchTag('NotIndexed', () => Effect.succeed([])),
            )
            const feedback = yield* api.erc8004.feedback({ params: { pubkey: agent } }).pipe(fresh)
            return { agent, identities, count: feedback.count, averageRating: feedback.averageRating }
          }),
        { concurrency: 4 },
      )
      return Message.SucceededReadSummaries({ summaries })
    }).pipe(Effect.catch(failedWith(Message.FailedReadSummaries))),
})

/** Which account the wallet sends from. */
export const ConnectRegistrationWallet = Command.define('ConnectRegistrationWallet', {
  messages: [Message.SucceededConnectWallet, Message.FailedConnectWallet],
  execute: Effect.gen(function* () {
    const connection = yield* (yield* Wallet).connect
    return Message.SucceededConnectWallet({ connection })
  }).pipe(Effect.catch(failedWith(Message.FailedConnectWallet))),
})

/** The core prepares `register(agentURI)` with the agent's registration file on this origin. */
export const PrepareRegistration = Command.define('PrepareRegistration', {
  args: { agent: Schema.String },
  messages: [Message.SucceededPrepareRegistration, Message.FailedPrepareRegistration],
  execute: ({ agent }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      const call = yield* api.erc8004.registrationCall({ params: { pubkey: agent } })
      return Message.SucceededPrepareRegistration({ call })
    }).pipe(Effect.catch(failedWith(Message.FailedPrepareRegistration))),
})

/** The wallet sends it. */
export const SendRegistration = Command.define('SendRegistration', {
  args: { signer: WalletAddress, call: Erc8004RegistrationCall },
  messages: [Message.SucceededSendRegistration, Message.FailedSendRegistration],
  execute: ({ signer, call }) =>
    Wallet.use((wallet) => wallet.sendTransaction(signer, call)).pipe(
      Effect.map((hash) => Message.SucceededSendRegistration({ hash })),
      Effect.catch(failedWith(Message.FailedSendRegistration)),
    ),
})

/** ERC-721's `Transfer(address,address,uint256)`: a mint is one from the zero address. */
const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const zeroWord = `0x${'0'.repeat(64)}`

/** The token a registration minted on `registry` (CAIP-10): its `Transfer` from nobody, as decimal digits. */
export const mintedAgentId = (logs: ReadonlyArray<ReceiptLog>, registry: string): Option.Option<string> => {
  const address = registry.slice(registry.lastIndexOf(':') + 1).toLowerCase()
  return Option.flatMap(
    Array.findFirst(
      logs,
      (log) => log.address.toLowerCase() === address && log.topics[0] === transferTopic && log.topics[1] === zeroWord,
    ),
    (log) => Option.map(Option.fromUndefinedOr(log.topics[3]), (word) => BigInt(word).toString()),
  )
}

class Pending extends Schema.TaggedError<Pending>()('Pending', {}) {}

/** Waits for the transaction to be mined (polling every two seconds, up to three minutes) and reads the minted id. */
export const AwaitRegistration = Command.define('AwaitRegistration', {
  args: { hash: Schema.String, registry: Schema.String },
  messages: [Message.SucceededAwaitRegistration, Message.FailedAwaitRegistration],
  execute: ({ hash, registry }) =>
    Wallet.use((wallet) => wallet.receiptLogs(hash)).pipe(
      Effect.flatMap(Option.match({ onNone: () => Effect.fail(new Pending()), onSome: Effect.succeed })),
      Effect.retry({
        schedule: Schedule.spaced(Duration.seconds(2)),
        times: 90,
        while: (error) => error instanceof Pending,
      }),
      Effect.map((logs) =>
        Option.match(mintedAgentId(logs, registry), {
          onNone: () => Message.FailedAwaitRegistration({ failure: RegistrationFailure.NotMinted() }),
          onSome: (agentId) => Message.SucceededAwaitRegistration({ agentId }),
        }),
      ),
      Effect.catch(
        failedWith(({ problem }) =>
          Message.FailedAwaitRegistration({ failure: RegistrationFailure.Failed({ problem }) }),
        ),
      ),
    ),
})

/** The person's key claims the token for the agent, naming the gateway's MCP endpoint when the stage has one. */
export const PublishClaim = Command.define('PublishClaim', {
  args: {
    agent: Schema.String,
    registry: Schema.String,
    agentId: Schema.String,
    maybeMcp: Schema.Option(Schema.String),
  },
  messages: [Message.SucceededPublishClaim, Message.FailedPublishClaim],
  execute: ({ agent, registry, agentId, maybeMcp }) =>
    publishEvent((kit, createdAt) =>
      kit.erc8004ClaimTemplate(
        {
          subject: agent,
          registry,
          agentId,
          ...Option.match(maybeMcp, { onNone: () => ({}), onSome: (mcp) => ({ mcp }) }),
        },
        createdAt,
      ),
    ).pipe(
      Effect.as(Message.SucceededPublishClaim()),
      Effect.catch((error) => Effect.succeed(Message.FailedPublishClaim({ failure: publishFailureOf(error) }))),
    ),
})

// INIT

type Services = SidequestClient | Signers | Wallet
type UpdateReturn = Update.Return<Model, Message, Services>

export const init = (language: Language): Model => ({
  language,
  deployment: AsyncData.Idle(),
  summaries: AsyncData.Idle(),
  flow: Flow.Closed(),
})

/** Reads the stage's registries once, and the agents' summaries whenever the list is read. */
export const readFor = (model: Model, agents: ReadonlyArray<string>): UpdateReturn => {
  const readSummaries = Array.isReadonlyArrayEmpty(agents) ? [] : [ReadSummaries({ agents })]
  return AsyncData.isIdle(model.deployment)
    ? {
        model: modifyFields(model, { deployment: () => AsyncData.Loading() }),
        commands: [ReadDeployment(), ...readSummaries],
      }
    : { model, commands: readSummaries }
}

// DERIVED

/** The stage's identity registry, once read, when it has one. */
export const identityRegistryOf = (model: Model): Option.Option<string> =>
  Option.flatMap(AsyncData.getData(model.deployment), (deployment) => Option.fromNullishOr(deployment.identityRegistry))

/** What the page shows for an agent, once read. */
export const summaryOf = (model: Model, agent: string): Option.Option<Summary> =>
  Option.flatMap(AsyncData.getData(model.summaries), (summaries) =>
    Array.findFirst(summaries, (summary) => summary.agent === agent),
  )

// UPDATE

const withFlow = (model: Model, flow: Flow): Model => modifyFields(model, { flow: () => flow })

/** The agent a registration is about, while one is open. */
export const agentOf = (flow: Flow): Option.Option<string> =>
  Flow.match(flow, {
    Closed: () => Option.none(),
    Connecting: ({ agent }) => Option.some(agent),
    Preparing: ({ agent }) => Option.some(agent),
    Sending: ({ agent }) => Option.some(agent),
    Mining: ({ agent }) => Option.some(agent),
    Claiming: ({ agent }) => Option.some(agent),
    Claimed: ({ agent }) => Option.some(agent),
    Failed: ({ agent }) => Option.some(agent),
  })

const failed = (model: Model, failure: RegistrationFailure): UpdateReturn =>
  Option.match(agentOf(model.flow), {
    onNone: () => ({ model }),
    onSome: (agent) => ({ model: withFlow(model, Flow.Failed({ agent, failure })) }),
  })

const failedWithProblem = (model: Model, problem: Problem) => failed(model, RegistrationFailure.Failed({ problem }))

/** The agents whose summaries are on the page, to read again after a claim. */
const summarized = (model: Model): ReadonlyArray<string> =>
  Option.match(AsyncData.getData(model.summaries), {
    onNone: () => [],
    onSome: (summaries) => summaries.map((summary) => summary.agent),
  })

type Group = Partial<Handlers<Message, UpdateReturn>>

const readHandlers = (model: Model) =>
  ({
    SucceededReadDeployment: ({ deployment }) => ({
      model: modifyFields(model, { deployment: () => DeploymentData.Success({ data: deployment }) }),
    }),
    FailedReadDeployment: ({ problem }) => ({
      model: modifyFields(model, { deployment: () => DeploymentData.Failure({ error: problem }) }),
    }),
    SucceededReadSummaries: ({ summaries }) => ({
      model: modifyFields(model, { summaries: () => SummariesData.Success({ data: summaries }) }),
    }),
    FailedReadSummaries: ({ problem }) => ({
      model: modifyFields(model, { summaries: () => SummariesData.Failure({ error: problem }) }),
    }),
  }) satisfies Group

const registerHandlers = (model: Model) =>
  ({
    ClickedRegister: ({ agent, maybeMcp }) =>
      Flow.guards.Closed(model.flow) || Flow.guards.Claimed(model.flow) || Flow.guards.Failed(model.flow)
        ? { model: withFlow(model, Flow.Connecting({ agent, maybeMcp })), commands: [ConnectRegistrationWallet()] }
        : { model },
    ClickedCloseRegistration: () => ({ model: withFlow(model, Flow.Closed()) }),
    SucceededConnectWallet: ({ connection }) => {
      const flow = model.flow
      return Flow.guards.Connecting(flow)
        ? {
            model: withFlow(
              model,
              Flow.Preparing({ agent: flow.agent, maybeMcp: flow.maybeMcp, signer: connection.address }),
            ),
            commands: [PrepareRegistration({ agent: flow.agent })],
          }
        : { model }
    },
    FailedConnectWallet: ({ problem }) => failedWithProblem(model, problem),
    SucceededPrepareRegistration: ({ call }) => {
      const flow = model.flow
      return Flow.guards.Preparing(flow)
        ? {
            model: withFlow(
              model,
              Flow.Sending({ agent: flow.agent, maybeMcp: flow.maybeMcp, signer: flow.signer, call }),
            ),
            commands: [SendRegistration({ signer: flow.signer, call })],
          }
        : { model }
    },
    FailedPrepareRegistration: ({ problem }) => failedWithProblem(model, problem),
    SucceededSendRegistration: ({ hash }) => {
      const flow = model.flow
      return Flow.guards.Sending(flow)
        ? Option.match(identityRegistryOf(model), {
            onNone: () => failed(model, RegistrationFailure.NotMinted()),
            onSome: (registry) => ({
              model: withFlow(model, Flow.Mining({ agent: flow.agent, maybeMcp: flow.maybeMcp, registry, hash })),
              commands: [AwaitRegistration({ hash, registry })],
            }),
          })
        : { model }
    },
    FailedSendRegistration: ({ problem }) => failedWithProblem(model, problem),
    SucceededAwaitRegistration: ({ agentId }) => {
      const flow = model.flow
      return Flow.guards.Mining(flow)
        ? {
            model: withFlow(model, Flow.Claiming({ agent: flow.agent, agentId })),
            commands: [PublishClaim({ agent: flow.agent, registry: flow.registry, agentId, maybeMcp: flow.maybeMcp })],
          }
        : { model }
    },
    FailedAwaitRegistration: ({ failure }) => failed(model, failure),
    SucceededPublishClaim: () => {
      const flow = model.flow
      if (!Flow.guards.Claiming(flow)) {
        return { model }
      }
      const claimed = withFlow(model, Flow.Claimed({ agent: flow.agent, agentId: flow.agentId }))
      return Array.match(summarized(model), {
        onEmpty: () => ({ model: claimed }),
        onNonEmpty: (agents) => ({ model: claimed, commands: [ReadSummaries({ agents })] }),
      })
    },
    FailedPublishClaim: ({ failure }) => failed(model, RegistrationFailure.Claim({ failure })),
  }) satisfies Group

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, { ...readHandlers(model), ...registerHandlers(model) })
