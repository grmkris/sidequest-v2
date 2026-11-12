import {
  Bytes32,
  Delivery,
  Digest,
  DisputeReason,
  EscrowStage,
  EscrowStatus,
  FundingRequest,
  JobId,
  Terms,
  TypedData,
  WalletAddress,
  WalletSignature,
  webCrypto,
} from '@sidequest/protocol'
import { Duration, Effect, Option, Schema } from 'effect'
import { AsyncData, Command, File, type Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'
import { SidequestClient } from '../../Api.ts'
import { FormStatus } from '../../Forms.ts'
import { Language } from '../../Language.ts'
import type { Handlers } from '../../Handlers.ts'
import { failedWith, Problem } from '../../Problem.ts'
import { Wallet } from '../../Wallet.ts'

// The hire's money, for its buyer and its worker. Each step is a signature in the person's wallet over typed data the
// server prepared, which the server relays: fund (the buyer's ERC-3009 authorization), deliver (the worker's hash),
// approve or reject (the buyer). The job follows the chain, so after a signature the page asks the chain reader again,
// waiting longer each time, until the escrow shows the step.

// MODEL

const SettlementRole = Schema.Literals(['buyer', 'worker'])
type SettlementRole = typeof SettlementRole.Type

/** Which signature a step is. */
export const SignKind = Schema.Literals(['fund', 'deliver', 'approve', 'reject'])
export type SignKind = typeof SignKind.Type

export const Flow = defineTaggedUnion({
  Idle: {},
  PreparingFunding: {},
  ReviewingFunding: { request: FundingRequest },
  EditingDelivery: { url: Schema.String, hash: Schema.String, status: FormStatus },
  RecordingDelivery: {},
  ConfirmingApproval: {},
  EditingRejection: { reason: Schema.String, status: FormStatus },
  Preparing: { kind: SignKind, maybeReason: Schema.Option(DisputeReason) },
  Signing: { kind: SignKind, maybeReason: Schema.Option(DisputeReason) },
  Submitting: { kind: SignKind },
  Submitted: { kind: SignKind, maybeTransaction: Schema.Option(Bytes32) },
})
export type Flow = typeof Flow.Type

/** Following the chain after a signature: the attempt the next read is, or stopped after too many. */
export const Poll = defineTaggedUnion({
  Idle: {},
  Waiting: { kind: SignKind, attempt: Schema.Int },
  GaveUp: { kind: SignKind },
})
export type Poll = typeof Poll.Type

const Status = AsyncData.Schema(EscrowStatus, Problem)

/** What the job page knows that the escrow does not: who is looking, their wallet, the agreed terms, and for the
 * buyer the delivery's address and the reason they gave for a rejection. */
export const Setup = Schema.Struct({
  role: SettlementRole,
  maybeSigner: Schema.Option(WalletAddress),
  maybeTerms: Schema.Option(Terms),
  maybeDeliveryUrl: Schema.Option(Schema.String),
  maybeDisputeReason: Schema.Option(Schema.String),
})
export type Setup = typeof Setup.Type

export const Model = Schema.Struct({
  language: Language,
  job: JobId,
  setup: Setup,
  status: Status.schema,
  flow: Flow,
  poll: Poll,
  maybeProblem: Schema.Option(Problem),
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  SucceededReadPayment: { status: EscrowStatus },
  FailedReadPayment: { problem: Problem },
  ClickedReviewFunding: {},
  SucceededPrepareFunding: { request: FundingRequest },
  FailedPrepareFunding: { problem: Problem },
  ClickedSignFunding: {},
  ClickedCancel: {},
  ClickedDeliver: {},
  UpdatedDeliveryUrl: { value: Schema.String },
  UpdatedDeliveryHash: { value: Schema.String },
  SelectedArtifact: { files: Schema.Array(File.File) },
  CompletedHashArtifact: { maybeHash: Schema.Option(Digest) },
  SubmittedDelivery: {},
  SucceededRecordDelivery: {},
  FailedRecordDelivery: { problem: Problem },
  ClickedApprove: {},
  ClickedConfirmApproval: {},
  ClickedReject: {},
  UpdatedReason: { value: Schema.String },
  SubmittedRejection: {},
  SucceededPrepareSignature: { kind: SignKind, typedData: TypedData },
  FailedPrepareSignature: { problem: Problem },
  SucceededSignTypedData: { kind: SignKind, signature: WalletSignature },
  FailedSignTypedData: { problem: Problem },
  SucceededSubmitSignature: { kind: SignKind, transactionHash: Bytes32 },
  FailedSubmitSignature: { problem: Problem },
  CompletedWaitBeforeCheck: {},
  ClickedCheckAgain: {},
})
export type Message = typeof Message.Type

/** The escrow moved: the job page reads the job again. */
export const OutMessage = defineMessageUnion({ ChainMoved: {} })
export type OutMessage = typeof OutMessage.Type

// COMMAND

export const ReadPayment = Command.define('ReadPayment', {
  args: { job: JobId },
  messages: [Message.SucceededReadPayment, Message.FailedReadPayment],
  execute: ({ job }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      const status = yield* api.settlement.payment({ params: { job } })
      return Message.SucceededReadPayment({ status })
    }).pipe(Effect.catch(failedWith(Message.FailedReadPayment))),
})

export const PrepareFunding = Command.define('PrepareFunding', {
  args: { job: JobId, payer: WalletAddress },
  messages: [Message.SucceededPrepareFunding, Message.FailedPrepareFunding],
  execute: ({ job, payer }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      const request = yield* api.settlement.funding({ params: { job }, query: { payer } })
      return Message.SucceededPrepareFunding({ request })
    }).pipe(Effect.catch(failedWith(Message.FailedPrepareFunding))),
})

export const RecordDelivery = Command.define('RecordDelivery', {
  args: { job: JobId, url: Delivery.fields.url, artifactHash: Digest },
  messages: [Message.SucceededRecordDelivery, Message.FailedRecordDelivery],
  execute: ({ job, url, artifactHash }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      yield* api.jobs.deliver({ params: { job }, payload: { url, artifactHash } })
      return Message.SucceededRecordDelivery()
    }).pipe(Effect.catch(failedWith(Message.FailedRecordDelivery))),
})

/** The typed data of a delivery, an approval or a rejection, as the server prepared it. */
export const PrepareSignature = Command.define('PrepareSignature', {
  args: { job: JobId, kind: SignKind },
  messages: [Message.SucceededPrepareSignature, Message.FailedPrepareSignature],
  execute: ({ job, kind }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      const params = { params: { job } }
      const typedData = yield* kind === 'approve'
        ? api.settlement.approvalToSign(params)
        : kind === 'reject'
          ? api.settlement.rejectionToSign(params)
          : api.settlement.deliveryToSign(params)
      return Message.SucceededPrepareSignature({ kind, typedData })
    }).pipe(Effect.catch(failedWith(Message.FailedPrepareSignature))),
})

export const SignTypedData = Command.define('SignTypedData', {
  args: { kind: SignKind, signer: WalletAddress, typedData: TypedData },
  messages: [Message.SucceededSignTypedData, Message.FailedSignTypedData],
  execute: ({ kind, signer, typedData }) =>
    Effect.gen(function* () {
      const signature = yield* (yield* Wallet).signTypedData(signer, typedData)
      return Message.SucceededSignTypedData({ kind, signature })
    }).pipe(Effect.catch(failedWith(Message.FailedSignTypedData))),
})

/** Hands the signature to the server, which relays it to the chain. */
export const SubmitSignature = Command.define('SubmitSignature', {
  args: { job: JobId, kind: SignKind, signature: WalletSignature, maybeReason: Schema.Option(DisputeReason) },
  messages: [Message.SucceededSubmitSignature, Message.FailedSubmitSignature],
  execute: ({ job, kind, signature, maybeReason }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      const params = { job }
      const relayed = yield* kind === 'fund'
        ? api.settlement.fund({ params, payload: { signature } })
        : kind === 'deliver'
          ? api.settlement.signDelivery({ params, payload: { signature } })
          : kind === 'approve'
            ? api.settlement.approve({ params, payload: { signature } })
            : api.settlement.reject({ params, payload: { signature, reason: Option.getOrElse(maybeReason, () => '') } })
      return Message.SucceededSubmitSignature({ kind, transactionHash: relayed.transactionHash })
    }).pipe(Effect.catch(failedWith(Message.FailedSubmitSignature))),
})

/** The pause before asking the chain reader again: 2, 4, 8, 16 and then 30 seconds. */
export const pauseBefore = (attempt: number): Duration.Duration => Duration.seconds(Math.min(2 ** (attempt + 1), 30))

export const WaitBeforeCheck = Command.define('WaitBeforeCheck', {
  args: { attempt: Schema.Int },
  messages: [Message.CompletedWaitBeforeCheck],
  execute: ({ attempt }) => Effect.sleep(pauseBefore(attempt)).pipe(Effect.as(Message.CompletedWaitBeforeCheck())),
})

/** The SHA-256 of the delivered file, computed in the browser. The file never leaves it. */
export const HashArtifact = Command.define('HashArtifact', {
  args: { file: File.File },
  messages: [Message.CompletedHashArtifact],
  execute: ({ file }) =>
    File.readAsArrayBuffer(file).pipe(
      Effect.flatMap((buffer) => webCrypto.digest('SHA-256', new Uint8Array(buffer))),
      Effect.map((bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')),
      Effect.map((hex) => Message.CompletedHashArtifact({ maybeHash: Schema.decodeUnknownOption(Digest)(hex) })),
      Effect.catch(() => Effect.succeed(Message.CompletedHashArtifact({ maybeHash: Option.none() }))),
    ),
})

// INIT

export const init = (language: Language, job: JobId, setup: Setup): Update.Return<Model, Message, SidequestClient> => ({
  model: {
    language,
    job,
    setup,
    status: AsyncData.Loading(),
    flow: Flow.Idle(),
    poll: Poll.Idle(),
    maybeProblem: Option.none(),
  },
  commands: [ReadPayment({ job })],
})

/** The job page read the job again: keep the flow, take what it now knows. */
export const informSetup = (model: Model, setup: Setup): Model => modifyFields(model, { setup: () => setup })

/** Whether the escrow shows the step a signature was for. */
const reached = (kind: SignKind, stage: EscrowStage): boolean => {
  const order: ReadonlyArray<EscrowStage> = ['Unfunded', 'Funded', 'Delivered', 'Disputed', 'Settled']
  const target: Record<SignKind, EscrowStage> = {
    fund: 'Funded',
    deliver: 'Delivered',
    approve: 'Settled',
    reject: 'Disputed',
  }
  return order.indexOf(stage) >= order.indexOf(target[kind])
}

/** How many times the page asks before it offers to check again by hand: about five minutes in all. */
const mostChecks = 14

// UPDATE

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage, SidequestClient | Wallet>
type Group = Partial<Handlers<Message, UpdateReturn>>

const withFlow = (model: Model, flow: Flow): Model =>
  modifyFields(model, { flow: () => flow, maybeProblem: () => Option.none() })

const stopped = (model: Model, problem: Problem): UpdateReturn => ({
  model: modifyFields(model, { flow: () => Flow.Idle(), maybeProblem: () => Option.some(problem) }),
})

/** After a signature reached the server: show it as sent and start following the chain. */
const follow = (model: Model, kind: SignKind, maybeTransaction: Option.Option<Bytes32>): UpdateReturn => ({
  model: modifyFields(withFlow(model, Flow.Submitted({ kind, maybeTransaction })), {
    poll: () => Poll.Waiting({ kind, attempt: 0 }),
  }),
  commands: [WaitBeforeCheck({ attempt: 0 })],
})

/** A read while following the chain: done when the escrow shows the step, else wait longer, or stop. */
const checked = (model: Model, maybeStage: Option.Option<EscrowStage>): UpdateReturn => {
  if (!Poll.guards.Waiting(model.poll)) {
    return { model }
  }
  const { kind, attempt } = model.poll
  if (Option.exists(maybeStage, (stage) => reached(kind, stage))) {
    return {
      model: modifyFields(withFlow(model, Flow.Idle()), { poll: () => Poll.Idle() }),
      outMessage: OutMessage.ChainMoved(),
    }
  }
  return attempt + 1 >= mostChecks
    ? { model: modifyFields(model, { poll: () => Poll.GaveUp({ kind }) }) }
    : {
        model: modifyFields(model, { poll: () => Poll.Waiting({ kind, attempt: attempt + 1 }) }),
        commands: [WaitBeforeCheck({ attempt: attempt + 1 })],
      }
}

const checkAgain = (model: Model): UpdateReturn => {
  const poll = model.poll
  return Poll.guards.GaveUp(poll)
    ? {
        model: modifyFields(model, { poll: () => Poll.Waiting({ kind: poll.kind, attempt: 0 }) }),
        commands: [ReadPayment({ job: model.job })],
      }
    : { model }
}

const statusHandlers = (model: Model) =>
  ({
    SucceededReadPayment: ({ status }) =>
      checked(modifyFields(model, { status: () => Status.Success({ data: status }) }), Option.some(status.stage)),
    FailedReadPayment: ({ problem }) =>
      Poll.guards.Waiting(model.poll)
        ? checked(model, Option.none())
        : { model: modifyFields(model, { status: () => Status.Failure({ error: problem }) }) },
    CompletedWaitBeforeCheck: () => ({ model, commands: [ReadPayment({ job: model.job })] }),
    ClickedCheckAgain: () => checkAgain(model),
    ClickedCancel: () => ({ model: withFlow(model, Flow.Idle()) }),
  }) satisfies Group

const fundingHandlers = (model: Model) =>
  ({
    ClickedReviewFunding: () =>
      Option.match(model.setup.maybeSigner, {
        onNone: () => ({ model }),
        onSome: (payer) => ({
          model: withFlow(model, Flow.PreparingFunding()),
          commands: [PrepareFunding({ job: model.job, payer })],
        }),
      }),
    SucceededPrepareFunding: ({ request }) =>
      request.state === 'submitted'
        ? follow(model, 'fund', Option.none())
        : { model: withFlow(model, Flow.ReviewingFunding({ request })) },
    FailedPrepareFunding: ({ problem }) => stopped(model, problem),
    ClickedSignFunding: () =>
      Flow.guards.ReviewingFunding(model.flow)
        ? {
            model: withFlow(model, Flow.Signing({ kind: 'fund', maybeReason: Option.none() })),
            commands: [
              SignTypedData({
                kind: 'fund',
                signer: model.flow.request.payer,
                typedData: model.flow.request.typedData,
              }),
            ],
          }
        : { model },
  }) satisfies Group

const editDelivery = (model: Model, change: (url: string, hash: string) => { url: string; hash: string }): Model =>
  Flow.guards.EditingDelivery(model.flow)
    ? withFlow(
        model,
        Flow.EditingDelivery({ ...change(model.flow.url, model.flow.hash), status: FormStatus.Editing() }),
      )
    : model

const submitDelivery = (model: Model): UpdateReturn => {
  if (!Flow.guards.EditingDelivery(model.flow)) {
    return { model }
  }
  const { url, hash } = model.flow
  const maybeUrl = Schema.decodeUnknownOption(Delivery.fields.url)(url.trim())
  const maybeHash = Schema.decodeUnknownOption(Digest)(hash.trim().toLowerCase())
  if (Option.isNone(maybeUrl) || Option.isNone(maybeHash)) {
    return { model: withFlow(model, Flow.EditingDelivery({ url, hash, status: FormStatus.Invalid() })) }
  }
  return {
    model: withFlow(model, Flow.RecordingDelivery()),
    commands: [RecordDelivery({ job: model.job, url: maybeUrl.value, artifactHash: maybeHash.value })],
  }
}

const deliveryHandlers = (model: Model) =>
  ({
    ClickedDeliver: () => ({
      model: withFlow(model, Flow.EditingDelivery({ url: '', hash: '', status: FormStatus.Editing() })),
    }),
    UpdatedDeliveryUrl: ({ value }) => ({ model: editDelivery(model, (_url, hash) => ({ url: value, hash })) }),
    UpdatedDeliveryHash: ({ value }) => ({ model: editDelivery(model, (url) => ({ url, hash: value })) }),
    SelectedArtifact: ({ files }) =>
      Option.match(Option.fromNullishOr(files[0]), {
        onNone: () => ({ model }),
        onSome: (file) => ({ model, commands: [HashArtifact({ file })] }),
      }),
    CompletedHashArtifact: ({ maybeHash }) =>
      Option.match(maybeHash, {
        onNone: () => ({ model }),
        onSome: (hash) => ({ model: editDelivery(model, (url) => ({ url, hash })) }),
      }),
    SubmittedDelivery: () => submitDelivery(model),
    SucceededRecordDelivery: () => ({
      model: withFlow(model, Flow.Preparing({ kind: 'deliver', maybeReason: Option.none() })),
      commands: [PrepareSignature({ job: model.job, kind: 'deliver' })],
    }),
    FailedRecordDelivery: ({ problem }) => stopped(model, problem),
  }) satisfies Group

const submitRejection = (model: Model): UpdateReturn => {
  const flow = model.flow
  if (!Flow.guards.EditingRejection(flow)) {
    return { model }
  }
  return Option.match(Schema.decodeUnknownOption(DisputeReason)(flow.reason.trim()), {
    onNone: () => ({
      model: withFlow(model, Flow.EditingRejection({ reason: flow.reason, status: FormStatus.Invalid() })),
    }),
    onSome: (reason) => ({
      model: withFlow(model, Flow.Preparing({ kind: 'reject', maybeReason: Option.some(reason) })),
      commands: [PrepareSignature({ job: model.job, kind: 'reject' })],
    }),
  })
}

const reviewHandlers = (model: Model) =>
  ({
    ClickedApprove: () => ({ model: withFlow(model, Flow.ConfirmingApproval()) }),
    ClickedConfirmApproval: () => ({
      model: withFlow(model, Flow.Preparing({ kind: 'approve', maybeReason: Option.none() })),
      commands: [PrepareSignature({ job: model.job, kind: 'approve' })],
    }),
    ClickedReject: () => ({
      model: withFlow(model, Flow.EditingRejection({ reason: '', status: FormStatus.Editing() })),
    }),
    UpdatedReason: ({ value }) =>
      Flow.guards.EditingRejection(model.flow)
        ? { model: withFlow(model, Flow.EditingRejection({ reason: value, status: FormStatus.Editing() })) }
        : { model },
    SubmittedRejection: () => submitRejection(model),
  }) satisfies Group

const signatureHandlers = (model: Model) =>
  ({
    SucceededPrepareSignature: ({ kind, typedData }) =>
      Option.match(Flow.guards.Preparing(model.flow) ? model.setup.maybeSigner : Option.none(), {
        onNone: () => ({ model }),
        onSome: (signer) => ({
          model: withFlow(
            model,
            Flow.Signing({
              kind,
              maybeReason: Flow.guards.Preparing(model.flow) ? model.flow.maybeReason : Option.none(),
            }),
          ),
          commands: [SignTypedData({ kind, signer, typedData })],
        }),
      }),
    FailedPrepareSignature: ({ problem }) => stopped(model, problem),
    SucceededSignTypedData: ({ kind, signature }) => ({
      model: withFlow(model, Flow.Submitting({ kind })),
      commands: [
        SubmitSignature({
          job: model.job,
          kind,
          signature,
          maybeReason: Flow.guards.Signing(model.flow) ? model.flow.maybeReason : Option.none(),
        }),
      ],
    }),
    FailedSignTypedData: ({ problem }) => stopped(model, problem),
    SucceededSubmitSignature: ({ kind, transactionHash }) => follow(model, kind, Option.some(transactionHash)),
    FailedSubmitSignature: ({ problem }) =>
      Flow.guards.Submitting(model.flow) && Problem.guards.Conflict(problem) && problem.reason === 'PaymentSubmitted'
        ? follow(model, model.flow.kind, Option.none())
        : stopped(model, problem),
  }) satisfies Group

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    ...statusHandlers(model),
    ...fundingHandlers(model),
    ...deliveryHandlers(model),
    ...reviewHandlers(model),
    ...signatureHandlers(model),
  })
