import {
  EscrowRefusalReason,
  EscrowRefused,
  maxKeyJobs,
  NotIndexed,
  TypedData,
  WalletAddress,
  WalletSignature,
} from '@sidequest/protocol'
import { Array, Clock, Effect, Option, Schema } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import { AsyncData, Command, type Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'
import type { Handlers } from '../Handlers.ts'
import { Language } from '../Language.ts'
import { Gateway, GatewayRefusal, GatewayRefused } from '../Gateway.ts'
import { SidequestClient } from '../Api.ts'
import { DayChoice, dayChoiceOf } from '../Forms.ts'
import { failedWith, Problem, problemOf } from '../Problem.ts'
import { SignerFailed, SignerFailure } from '../Signer.ts'
import { Connection, Wallet } from '../Wallet.ts'
import { addressOf, sameAddress } from './job/money/message.ts'

// Delivery delegation for one job (SidequestOperator v2, `deliverDelegated`): the person is the job's funded worker,
// and their wallet lets one of their agents record that job's delivery on chain unattended. The core serves the typed
// data (`DeliveryDelegate` for the agent's delegate address and an expiry); the wallet the escrow pays signs it; the
// gateway stores the signature. It allows exactly one thing: recording a delivery on that one job, before the expiry.
// Forgetting it at the gateway does not undo the signature; `revokeDeliveryDelegate` on the operator contract does.

// MODEL

/** A job the person may delegate: one they are the funded worker of, its wallet the escrow pays, and its deadline. */
export const WorkerJob = Schema.Struct({
  job: Schema.String,
  title: Schema.String,
  receiver: WalletAddress,
  deliveryDeadline: Schema.Int,
})
export type WorkerJob = typeof WorkerJob.Type

/** Why a delegation stopped: the gateway refused, the core refused to prepare it, the signer could not sign the
 * gateway's authorization, or a problem with the wallet or the network (the wallet saying no among them). */
export const DelegationFailure = defineTaggedUnion({
  Gateway: { refusal: GatewayRefusal },
  Core: { reason: EscrowRefusalReason },
  SignerFailed: { reason: SignerFailure },
  Failed: { problem: Problem },
})
export type DelegationFailure = typeof DelegationFailure.Type

export const delegationFailureOf = (error: unknown): DelegationFailure => {
  if (error instanceof GatewayRefused) {
    return DelegationFailure.Gateway({ refusal: error.refusal })
  }
  if (error instanceof EscrowRefused) {
    return DelegationFailure.Core({ reason: error.reason })
  }
  if (error instanceof SignerFailed) {
    return DelegationFailure.SignerFailed({ reason: error.reason })
  }
  return DelegationFailure.Failed({ problem: problemOf(error) })
}

/** The job and how long, as the person chose them. */
const Choice = { agent: Schema.String, job: Schema.String, days: DayChoice, receiver: WalletAddress }

/** Where a delegation is, one at a time. */
export const Flow = defineTaggedUnion({
  Closed: {},
  Choosing: { agent: Schema.String, maybeJob: Schema.Option(Schema.String), days: DayChoice, invalid: Schema.Boolean },
  Connecting: Choice,
  WrongWallet: { ...Choice, connected: WalletAddress },
  Preparing: { ...Choice, signer: WalletAddress },
  Signing: { ...Choice, signer: WalletAddress, expiry: Schema.Int, typedData: TypedData },
  Storing: { agent: Schema.String, job: Schema.String, expiry: Schema.Int },
  Stored: { agent: Schema.String, job: Schema.String, expiry: Schema.Int },
  Failed: { agent: Schema.String, failure: DelegationFailure },
})
export type Flow = typeof Flow.Type

const JobsData = AsyncData.Schema(Schema.Array(WorkerJob), Problem)

export const Model = Schema.Struct({
  language: Language,
  flow: Flow,
  /** The jobs the person is the funded worker of, read when a delegation first opens. */
  jobs: JobsData.schema,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ClickedDelegate: { agent: Schema.String, pubkey: Schema.String },
  SucceededReadWorkerJobs: { jobs: Schema.Array(WorkerJob) },
  FailedReadWorkerJobs: { problem: Problem },
  SelectedJob: { job: Schema.String },
  SelectedDays: { value: Schema.String },
  SubmittedDelegation: {},
  SucceededConnectWallet: { connection: Connection },
  FailedConnectWallet: { problem: Problem },
  ClickedTryAgain: {},
  SucceededPrepare: { expiry: Schema.Int, typedData: TypedData },
  FailedPrepare: { failure: DelegationFailure },
  SucceededSign: { signature: WalletSignature },
  FailedSign: { problem: Problem },
  SucceededStore: {},
  FailedStore: { failure: DelegationFailure },
  ClickedCancel: {},
})
export type Message = typeof Message.Type

// COMMAND

/** The jobs `pubkey` proposed on that the chain funded with them as the worker, each with the wallet the escrow pays. */
export const ReadWorkerJobs = Command.define('ReadWorkerJobs', {
  args: { pubkey: Schema.String },
  messages: [Message.SucceededReadWorkerJobs, Message.FailedReadWorkerJobs],
  execute: ({ pubkey }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      const fresh = Effect.provideService(FetchHttpClient.RequestInit, { cache: 'no-cache' })
      const { items } = yield* api.events.personJobs({ params: { pubkey } }).pipe(fresh)
      const bids = Array.filter(Array.take(items, maxKeyJobs), (item) => item.role === 'bidder')
      const views = yield* Effect.forEach(
        bids,
        ({ job }) =>
          api.indexJobs.job({ params: { id: job } }).pipe(
            fresh,
            Effect.map(Option.some),
            Effect.catchTag('NotIndexed', () => Effect.succeed(Option.none())),
          ),
        { concurrency: 4 },
      )
      const jobs = Array.flatMap(Array.getSomes(views), (view) => {
        const funding = view.funding
        return view.stage === 'funded' && view.worker === pubkey && funding !== null
          ? Option.toArray(
              Option.map(addressOf(funding.fact.receiver), (receiver) => ({
                job: view.job,
                title: view.request.content.title,
                receiver,
                deliveryDeadline: funding.fact.deliveryDeadline,
              })),
            )
          : []
      })
      return Message.SucceededReadWorkerJobs({ jobs })
    }).pipe(Effect.catch(failedWith(Message.FailedReadWorkerJobs))),
})

/** Which account the wallet signs with, before it is asked for anything. */
export const ConnectWallet = Command.define('ConnectWallet', {
  messages: [Message.SucceededConnectWallet, Message.FailedConnectWallet],
  execute: Effect.gen(function* () {
    const connection = yield* (yield* Wallet).connect
    return Message.SucceededConnectWallet({ connection })
  }).pipe(Effect.catch(failedWith(Message.FailedConnectWallet))),
})

const Delegate = Schema.Struct({ delegate: WalletAddress })

/** The agent's delegate address from the gateway, then the `DeliveryDelegate` the core prepares for it, expiring the
 * days chosen from now. */
export const PrepareDelegation = Command.define('PrepareDelegation', {
  args: { agent: Schema.String, job: Schema.String, days: DayChoice },
  messages: [Message.SucceededPrepare, Message.FailedPrepare],
  execute: ({ agent, job, days }) =>
    Effect.gen(function* () {
      const answered = yield* (yield* Gateway).send('GET', `/api/agents/${agent}/delegations`, Option.none())
      const { delegate } = yield* Effect.mapError(
        Schema.decodeUnknownEffect(Delegate)(answered),
        () => new GatewayRefused({ refusal: GatewayRefusal.Invalid() }),
      )
      const expiry = Math.floor((yield* Clock.currentTimeMillis) / 1000) + Number(days) * 86_400
      const api = yield* (yield* SidequestClient).api
      const typedData = yield* api.escrow.deliveryDelegationToSign({
        params: { id: job },
        query: { delegate, expiry },
      })
      return Message.SucceededPrepare({ expiry, typedData })
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedPrepare({
            failure:
              error instanceof NotIndexed
                ? DelegationFailure.Core({ reason: 'RequestNotIndexed' })
                : delegationFailureOf(error),
          }),
        ),
      ),
    ),
})

/** The worker's wallet signs the delegation. */
export const SignDelegation = Command.define('SignDelegation', {
  args: { signer: WalletAddress, typedData: TypedData },
  messages: [Message.SucceededSign, Message.FailedSign],
  execute: ({ signer, typedData }) =>
    Wallet.use((wallet) => wallet.signTypedData(signer, typedData)).pipe(
      Effect.map((signature) => Message.SucceededSign({ signature })),
      Effect.catch(failedWith(Message.FailedSign)),
    ),
})

/** The gateway keeps the signature and its expiry for the agent and the job. */
export const StoreDelegation = Command.define('StoreDelegation', {
  args: { agent: Schema.String, job: Schema.String, signature: WalletSignature, expiry: Schema.Int },
  messages: [Message.SucceededStore, Message.FailedStore],
  execute: ({ agent, job, signature, expiry }) =>
    Gateway.use((gateway) =>
      gateway.send('POST', `/api/agents/${agent}/delegations`, Option.some({ job, signature, expiry })),
    ).pipe(
      Effect.as(Message.SucceededStore()),
      Effect.catch((error) => Effect.succeed(Message.FailedStore({ failure: delegationFailureOf(error) }))),
    ),
})

// INIT

type Services = SidequestClient | Gateway | Wallet
type UpdateReturn = Update.Return<Model, Message, Services>

export const init = (language: Language): Model => ({ language, flow: Flow.Closed(), jobs: AsyncData.Idle() })

/** No delegation is open: another agent's panel opened. */
export const closed = (model: Model): Model => modifyFields(model, { flow: () => Flow.Closed() })

// UPDATE

const withFlow = (model: Model, flow: Flow): Model => modifyFields(model, { flow: () => flow })

const jobOf = (model: Model, job: string): Option.Option<WorkerJob> =>
  Option.flatMap(AsyncData.getData(model.jobs), (jobs) => Array.findFirst(jobs, (found) => found.job === job))

const submitted = (model: Model): UpdateReturn => {
  const flow = model.flow
  if (!Flow.guards.Choosing(flow)) {
    return { model }
  }
  return Option.match(
    Option.flatMap(flow.maybeJob, (job) => jobOf(model, job)),
    {
      onNone: () => ({
        model: withFlow(
          model,
          Flow.Choosing({ agent: flow.agent, maybeJob: flow.maybeJob, days: flow.days, invalid: true }),
        ),
      }),
      onSome: ({ job, receiver }) => ({
        model: withFlow(model, Flow.Connecting({ agent: flow.agent, job, days: flow.days, receiver })),
        commands: [ConnectWallet()],
      }),
    },
  )
}

/** The wallet answered: the one the escrow pays goes on, any other is named. */
const connected = (model: Model, connection: Connection): UpdateReturn => {
  const flow = model.flow
  if (!Flow.guards.Connecting(flow) && !Flow.guards.WrongWallet(flow)) {
    return { model }
  }
  const { agent, job, days, receiver } = flow
  return sameAddress(connection.address, receiver)
    ? {
        model: withFlow(model, Flow.Preparing({ agent, job, days, receiver, signer: connection.address })),
        commands: [PrepareDelegation({ agent, job, days })],
      }
    : { model: withFlow(model, Flow.WrongWallet({ agent, job, days, receiver, connected: connection.address })) }
}

/** The flow's agent, while one is open. */
const agentOf = (flow: Flow): Option.Option<string> =>
  Flow.match(flow, {
    Closed: () => Option.none(),
    Choosing: ({ agent }) => Option.some(agent),
    Connecting: ({ agent }) => Option.some(agent),
    WrongWallet: ({ agent }) => Option.some(agent),
    Preparing: ({ agent }) => Option.some(agent),
    Signing: ({ agent }) => Option.some(agent),
    Storing: ({ agent }) => Option.some(agent),
    Stored: ({ agent }) => Option.some(agent),
    Failed: ({ agent }) => Option.some(agent),
  })

const failed = (model: Model, failure: DelegationFailure): UpdateReturn =>
  Option.match(agentOf(model.flow), {
    onNone: () => ({ model }),
    onSome: (agent) => ({ model: withFlow(model, Flow.Failed({ agent, failure })) }),
  })

type Group = Partial<Handlers<Message, UpdateReturn>>

const choiceHandlers = (model: Model) =>
  ({
    ClickedDelegate: ({ agent, pubkey }) => {
      const choosing = withFlow(model, Flow.Choosing({ agent, maybeJob: Option.none(), days: '7', invalid: false }))
      return AsyncData.isSuccess(model.jobs)
        ? { model: choosing }
        : {
            model: modifyFields(choosing, { jobs: () => AsyncData.Loading() }),
            commands: [ReadWorkerJobs({ pubkey })],
          }
    },
    SucceededReadWorkerJobs: ({ jobs }) => ({
      model: modifyFields(model, { jobs: () => JobsData.Success({ data: jobs }) }),
    }),
    FailedReadWorkerJobs: ({ problem }) => ({
      model: modifyFields(model, { jobs: () => JobsData.Failure({ error: problem }) }),
    }),
    SelectedJob: ({ job }) => ({
      model: Flow.guards.Choosing(model.flow)
        ? withFlow(
            model,
            Flow.Choosing({
              agent: model.flow.agent,
              maybeJob: Option.some(job),
              days: model.flow.days,
              invalid: false,
            }),
          )
        : model,
    }),
    SelectedDays: ({ value }) => {
      const flow = model.flow
      return Option.match(dayChoiceOf(value), {
        onNone: () => ({ model }),
        onSome: (days) => ({
          model: Flow.guards.Choosing(flow)
            ? withFlow(
                model,
                Flow.Choosing({ agent: flow.agent, maybeJob: flow.maybeJob, days, invalid: flow.invalid }),
              )
            : model,
        }),
      })
    },
    SubmittedDelegation: () => submitted(model),
    ClickedCancel: () => ({ model: withFlow(model, Flow.Closed()) }),
  }) satisfies Group

const signingHandlers = (model: Model) =>
  ({
    SucceededConnectWallet: ({ connection }) => connected(model, connection),
    FailedConnectWallet: ({ problem }) => failed(model, DelegationFailure.Failed({ problem })),
    ClickedTryAgain: () => {
      const flow = model.flow
      return Flow.guards.WrongWallet(flow)
        ? {
            model: withFlow(
              model,
              Flow.Connecting({ agent: flow.agent, job: flow.job, days: flow.days, receiver: flow.receiver }),
            ),
            commands: [ConnectWallet()],
          }
        : { model }
    },
    SucceededPrepare: ({ expiry, typedData }) => {
      const flow = model.flow
      return Flow.guards.Preparing(flow)
        ? {
            model: withFlow(
              model,
              Flow.Signing({
                agent: flow.agent,
                job: flow.job,
                days: flow.days,
                receiver: flow.receiver,
                signer: flow.signer,
                expiry,
                typedData,
              }),
            ),
            commands: [SignDelegation({ signer: flow.signer, typedData })],
          }
        : { model }
    },
    FailedPrepare: ({ failure }) => failed(model, failure),
    SucceededSign: ({ signature }) => {
      const flow = model.flow
      return Flow.guards.Signing(flow)
        ? {
            model: withFlow(model, Flow.Storing({ agent: flow.agent, job: flow.job, expiry: flow.expiry })),
            commands: [StoreDelegation({ agent: flow.agent, job: flow.job, signature, expiry: flow.expiry })],
          }
        : { model }
    },
    FailedSign: ({ problem }) => failed(model, DelegationFailure.Failed({ problem })),
    SucceededStore: () => {
      const flow = model.flow
      return {
        model: Flow.guards.Storing(flow)
          ? withFlow(model, Flow.Stored({ agent: flow.agent, job: flow.job, expiry: flow.expiry }))
          : model,
      }
    },
    FailedStore: ({ failure }) => failed(model, failure),
  }) satisfies Group

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, { ...choiceHandlers(model), ...signingHandlers(model) })
