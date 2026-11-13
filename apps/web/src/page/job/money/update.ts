import type { JobView } from '@sidequest/fold'
import { Bytes32, NetworkRef, TypedData, WalletAddress, WalletSignature } from '@sidequest/protocol'
import { Duration, Effect, Option, Schema } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import { Command, type Update } from 'foldkit'
import { modifyFields } from 'foldkit/struct'
import { SidequestClient } from '../../../Api.ts'
import { FormStatus } from '../../../Forms.ts'
import type { Handlers } from '../../../Handlers.ts'
import type { Language } from '../../../Language.ts'
import { failedWith } from '../../../Problem.ts'
import { PublishFailure, PublishRefusal, publishEvent, publishFailureOf } from '../../../Publishing.ts'
import { Signers } from '../../../Signer.ts'
import { type Connection, Wallet } from '../../../Wallet.ts'
import {
  type Attempt,
  type Connected,
  Flow,
  Message,
  type Model,
  MoneyFailure,
  moneyFailureOf,
  OutMessage,
  type Prepared,
  reached,
  sameAddress,
  settledFlow,
  type Step,
  stepOf,
  Work,
} from './message.ts'

// The money steps' Commands and update (see `message.ts` for the Model and the Messages).

// COMMAND

/** Where the job's payment stands: the escrow it is held in and the transactions relayed for it. */
export const ReadPayment = Command.define('ReadPayment', {
  args: { job: Schema.String },
  messages: [Message.SucceededReadPayment, Message.FailedReadPayment],
  execute: ({ job }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      const status = yield* api.indexSettlement.payment({ params: { id: job } })
      return Message.SucceededReadPayment({ status })
    }).pipe(Effect.catch(failedWith(Message.FailedReadPayment))),
})

/** Which account the wallet signs with, and on which chain, before it is asked for anything. */
export const ReadWalletAccount = Command.define('ReadWalletAccount', {
  messages: [Message.SucceededReadWalletAccount, Message.FailedReadWalletAccount],
  execute: Effect.gen(function* () {
    const connection = yield* (yield* Wallet).connect
    return Message.SucceededReadWalletAccount({ connection })
  }).pipe(Effect.catch(failedWith(Message.FailedReadWalletAccount))),
})

/** What the buyer's wallet signs to fund the proposal from `payer`, and the payment it binds. */
export const Quote = Command.define('Quote', {
  args: { job: Schema.String, proposal: Schema.String, payer: WalletAddress },
  messages: [Message.SucceededPrepare, Message.FailedPrepare],
  execute: ({ job, proposal, payer }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      const funding = yield* api.indexSettlement.quote({ params: { id: job, proposal }, query: { payer } })
      return Message.SucceededPrepare({ typedData: funding.typedData, maybeFunding: Option.some(funding) })
    }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedPrepare({ failure: moneyFailureOf(error) })))),
})

/** The typed data of a delivery of `deliveryHash`, an approval or a rejection, as the API prepared it. */
export const PrepareSignature = Command.define('PrepareSignature', {
  args: {
    job: Schema.String,
    step: Schema.Literals(['deliver', 'approve', 'reject']),
    maybeDeliveryHash: Schema.Option(Bytes32),
  },
  messages: [Message.SucceededPrepare, Message.FailedPrepare],
  execute: ({ job, step, maybeDeliveryHash }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      const params = { id: job }
      const typedData = yield* step === 'approve'
        ? api.indexSettlement.approvalToSign({ params })
        : step === 'reject'
          ? api.indexSettlement.rejectionToSign({ params })
          : api.indexSettlement.deliveryToSign({
              params,
              query: { deliveryHash: Option.getOrElse(maybeDeliveryHash, () => '') },
            })
      return Message.SucceededPrepare({ typedData, maybeFunding: Option.none() })
    }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedPrepare({ failure: moneyFailureOf(error) })))),
})

const unpublished = (error: unknown) => Effect.succeed(Message.FailedPublishEvent({ failure: publishFailureOf(error) }))

/** What a delivery note cannot carry: the vocabulary refuses it, as the index would. */
const badContent = PublishFailure.Refused({ refusal: PublishRefusal.Invalid({ reason: 'badContent' }) })

/** The worker's signed delivery note, whose hash of what was delivered and where is what their wallet then signs. */
export const PublishDeliveryNote = Command.define('PublishDeliveryNote', {
  args: {
    job: Schema.String,
    buyer: Schema.String,
    network: NetworkRef,
    maybeUrl: Schema.Option(Schema.String),
    maybeNote: Schema.Option(Schema.String),
  },
  messages: [Message.SucceededPublishEvent, Message.FailedPublishEvent],
  execute: ({ job, buyer, network, maybeUrl, maybeNote }) =>
    Effect.gen(function* () {
      const delivered = {
        job,
        ...Option.match(maybeUrl, { onNone: () => ({}), onSome: (url) => ({ url }) }),
        ...Option.match(maybeNote, { onNone: () => ({}), onSome: (note) => ({ note }) }),
      }
      const kit = yield* (yield* Signers).kit
      const maybeHash = yield* kit.deliveryHash(delivered)
      if (Option.isNone(maybeHash)) {
        return Message.FailedPublishEvent({ failure: badContent })
      }
      yield* publishEvent((nostr, createdAt) =>
        nostr.deliveryNoteTemplate({ ...delivered, buyer, deliveryHash: maybeHash.value }, network, createdAt),
      )
      return Message.SucceededPublishEvent({ maybeDeliveryHash: maybeHash })
    }).pipe(Effect.catch(unpublished)),
})

/** The buyer's reason for a rejection, on the record before their wallet signs it. */
export const PublishRejectionReason = Command.define('PublishRejectionReason', {
  args: { job: Schema.String, reason: Schema.String },
  messages: [Message.SucceededPublishEvent, Message.FailedPublishEvent],
  execute: ({ job, reason }) =>
    publishEvent((kit, createdAt) =>
      kit.statementTemplate({ job, type: 'rejection_reason', text: reason }, createdAt),
    ).pipe(Effect.as(Message.SucceededPublishEvent({ maybeDeliveryHash: Option.none() })), Effect.catch(unpublished)),
})

/** Moves the wallet to Arc testnet, then reads the chain it is on. */
export const SwitchNetwork = Command.define('SwitchNetwork', {
  messages: [Message.SucceededSwitchNetwork, Message.FailedSwitchNetwork],
  execute: Effect.gen(function* () {
    const wallet = yield* Wallet
    yield* wallet.switchToArc
    const connection = yield* wallet.connect
    return Message.SucceededSwitchNetwork({ chainId: connection.chainId })
  }).pipe(Effect.catch(failedWith(Message.FailedSwitchNetwork))),
})

export const SignTypedData = Command.define('SignTypedData', {
  args: { signer: WalletAddress, typedData: TypedData },
  messages: [Message.SucceededSign, Message.FailedSign],
  execute: ({ signer, typedData }) =>
    Effect.gen(function* () {
      const signature = yield* (yield* Wallet).signTypedData(signer, typedData)
      return Message.SucceededSign({ signature })
    }).pipe(Effect.catch(failedWith(Message.FailedSign))),
})

/** Hands the signature to the API, which checks what it can and relays it to the chain. */
export const Submit = Command.define('Submit', {
  args: {
    job: Schema.String,
    work: Work,
    signer: WalletAddress,
    signature: WalletSignature,
    maybeDeliveryHash: Schema.Option(Bytes32),
  },
  messages: [Message.SucceededSubmit, Message.FailedSubmit],
  execute: ({ job, work, signer, signature, maybeDeliveryHash }) =>
    Effect.gen(function* () {
      const api = (yield* (yield* SidequestClient).api).indexSettlement
      const params = { id: job }
      const relayed = yield* Work.match(work, {
        Fund: ({ proposal }) => api.fund({ params: { id: job, proposal }, payload: { payer: signer, signature } }),
        Deliver: () =>
          api.deliver({
            params,
            payload: { deliveryHash: Option.getOrElse(maybeDeliveryHash, () => ''), signature },
          }),
        Approve: () => api.approve({ params, payload: { signature } }),
        Reject: () => api.reject({ params, payload: { signature } }),
      })
      return Message.SucceededSubmit({ transactionHash: relayed.transactionHash })
    }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedSubmit({ failure: moneyFailureOf(error) })))),
})

/** The pause before reading the job again: 2, 4, 8, 16 and then 30 seconds. */
export const pauseBefore = (attempt: number): Duration.Duration => Duration.seconds(Math.min(2 ** (attempt + 1), 30))

export const WaitBeforeCheck = Command.define('WaitBeforeCheck', {
  args: { attempt: Schema.Int },
  messages: [Message.CompletedWaitBeforeCheck],
  execute: ({ attempt }) => Effect.sleep(pauseBefore(attempt)).pipe(Effect.as(Message.CompletedWaitBeforeCheck())),
})

/** The job as the index folds it now, past what the browser's cache kept. */
export const ReadMoneyJob = Command.define('ReadMoneyJob', {
  args: { job: Schema.String },
  messages: [Message.SucceededReadJob, Message.FailedReadJob],
  execute: ({ job }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      const view = yield* api.indexJobs
        .job({ params: { id: job } })
        .pipe(Effect.provideService(FetchHttpClient.RequestInit, { cache: 'no-cache' }))
      return Message.SucceededReadJob({ view })
    }).pipe(Effect.catch(failedWith(Message.FailedReadJob))),
})

// INIT

export const init = (language: Language, job: string): Model => ({
  language,
  job,
  flow: Flow.Idle(),
  maybePayment: Option.none(),
})

// UPDATE

type Services = SidequestClient | Wallet | Signers
export type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage, Services>
type Group = Partial<Handlers<Message, UpdateReturn>>

/** How many times the page reads the job before it offers to read again by hand: about five minutes in all. */
export const mostChecks = 14

const withFlow = (model: Model, flow: Flow): Model => modifyFields(model, { flow: () => flow })

const failed = (model: Model, step: Step, failure: MoneyFailure): UpdateReturn => ({
  model: withFlow(model, Flow.Failed({ step, failure })),
})

/** Starts a step once nothing else is in flight: first ask the wallet which account it signs with. */
const start = (model: Model, attempt: Attempt): UpdateReturn =>
  settledFlow(model.flow) || isEditing(model.flow)
    ? { model: withFlow(model, Flow.Connecting({ attempt })), commands: [ReadWalletAccount()] }
    : { model }

/** The buyer funds `proposal` from `payer`: a child capability, for a button the job page draws on the proposal. */
export const fund = (model: Model, funding: { readonly proposal: string; readonly payer: string }): UpdateReturn =>
  start(model, { work: Work.Fund({ proposal: funding.proposal }), signer: funding.payer })

const isEditing = (flow: Flow): boolean =>
  Flow.guards.EditingDelivery(flow) || Flow.guards.ConfirmingApproval(flow) || Flow.guards.EditingRejection(flow)

/** The wallet signs as the step's signer: publish what goes on the record first, else prepare what it signs. */
const connected = (model: Model, attempt: Attempt, connection: Connection): UpdateReturn => {
  const next: Connected = { ...attempt, connection, maybeDeliveryHash: Option.none() }
  const job = model.job
  return Work.match(attempt.work, {
    Fund: ({ proposal }) => ({
      model: withFlow(model, Flow.Preparing({ connected: next })),
      commands: [Quote({ job, proposal, payer: attempt.signer })],
    }),
    Deliver: ({ buyer, network, maybeUrl, maybeNote }) => ({
      model: withFlow(model, Flow.Publishing({ connected: next })),
      commands: [PublishDeliveryNote({ job, buyer, network, maybeUrl, maybeNote })],
    }),
    Approve: () => ({
      model: withFlow(model, Flow.Preparing({ connected: next })),
      commands: [PrepareSignature({ job, step: 'approve', maybeDeliveryHash: Option.none() })],
    }),
    Reject: ({ reason }) => ({
      model: withFlow(model, Flow.Publishing({ connected: next })),
      commands: [PublishRejectionReason({ job, reason })],
    }),
  })
}

/** The wallet is on the chain the typed data names. */
export const onChain = (prepared: Prepared): boolean =>
  prepared.connection.chainId === prepared.typedData.domain.chainId

const signing = (model: Model, prepared: Prepared): UpdateReturn => ({
  model: withFlow(model, Flow.Signing({ prepared })),
  commands: [SignTypedData({ signer: prepared.signer, typedData: prepared.typedData })],
})

/** Ready to sign: funding waits for the buyer to read the slip; the other steps sign at once on the right chain. */
const ready = (model: Model, prepared: Prepared): UpdateReturn =>
  Work.guards.Fund(prepared.work) || !onChain(prepared)
    ? { model: withFlow(model, Flow.Ready({ prepared })) }
    : signing(model, prepared)

/** After the relay: read the job until the fold shows the step, waiting longer each time, then stop and offer more. */
const following = (model: Model, step: Step, transactionHash: Bytes32, attempt: number): UpdateReturn =>
  attempt >= mostChecks
    ? { model: withFlow(model, Flow.GaveUp({ step, transactionHash })) }
    : {
        model: withFlow(model, Flow.Following({ step, transactionHash, attempt })),
        commands: [WaitBeforeCheck({ attempt })],
      }

const jobRead = (model: Model, maybeView: Option.Option<JobView>) => {
  const flow = model.flow
  if (!Flow.guards.Following(flow)) {
    return { model }
  }
  const { step, transactionHash, attempt } = flow
  return Option.exists(maybeView, (view) => reached(step, view))
    ? {
        model: withFlow(model, Flow.Done({ step, transactionHash })),
        commands: [ReadPayment({ job: model.job })],
      }
    : following(model, step, transactionHash, attempt + 1)
}

const readingHandlers = (model: Model) =>
  ({
    SucceededReadPayment: ({ status }) => ({ model: modifyFields(model, { maybePayment: () => Option.some(status) }) }),
    FailedReadPayment: () => ({ model }),
    CompletedWaitBeforeCheck: () =>
      Flow.guards.Following(model.flow) ? { model, commands: [ReadMoneyJob({ job: model.job })] } : { model },
    SucceededReadJob: ({ view }) => ({
      ...jobRead(model, Option.some(view)),
      outMessage: OutMessage.ReadJob({ view }),
    }),
    FailedReadJob: () => jobRead(model, Option.none()),
    ClickedCheckAgain: () =>
      Flow.guards.GaveUp(model.flow)
        ? {
            model: withFlow(
              model,
              Flow.Following({ step: model.flow.step, transactionHash: model.flow.transactionHash, attempt: 0 }),
            ),
            commands: [ReadMoneyJob({ job: model.job })],
          }
        : { model },
    ClickedReadAgain: () => ({ model: withFlow(model, Flow.Idle()), commands: [ReadMoneyJob({ job: model.job })] }),
  }) satisfies Group

const trimmed = (value: string): Option.Option<string> => Option.liftPredicate(value.trim(), (text) => text !== '')

const HttpsUrl = Schema.String.check(Schema.isPattern(/^https:\/\/\S{1,2000}$/u))
const NoteText = Schema.String.check(Schema.isMaxLength(4000))
const ReasonText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000))

/** A delivery states where the work is, its note, or both: an address that is `https`, a note of up to 4000
 * characters. */
export const deliveryOf = (url: string, note: string) => {
  const maybeUrl = trimmed(url)
  const maybeNote = trimmed(note)
  const urlValid = Option.match(maybeUrl, { onNone: () => true, onSome: Schema.is(HttpsUrl) })
  const noteValid = Option.match(maybeNote, { onNone: () => true, onSome: Schema.is(NoteText) })
  return Option.isNone(maybeUrl) && Option.isNone(maybeNote)
    ? Option.none()
    : urlValid && noteValid
      ? Option.some({ maybeUrl, maybeNote })
      : Option.none()
}

const formHandlers = (model: Model) =>
  ({
    ClickedFund: (funding) => fund(model, funding),
    ClickedDeliver: ({ signer, buyer, network }) =>
      settledFlow(model.flow)
        ? {
            model: withFlow(
              model,
              Flow.EditingDelivery({
                attempt: {
                  work: Work.Deliver({ buyer, network, maybeUrl: Option.none(), maybeNote: Option.none() }),
                  signer,
                },
                url: '',
                note: '',
                status: FormStatus.Editing(),
              }),
            ),
          }
        : { model },
    UpdatedDeliveryUrl: ({ value }) =>
      Flow.guards.EditingDelivery(model.flow)
        ? { model: withFlow(model, Flow.EditingDelivery({ ...model.flow, url: value, status: FormStatus.Editing() })) }
        : { model },
    UpdatedDeliveryNote: ({ value }) =>
      Flow.guards.EditingDelivery(model.flow)
        ? { model: withFlow(model, Flow.EditingDelivery({ ...model.flow, note: value, status: FormStatus.Editing() })) }
        : { model },
    SubmittedDelivery: () => {
      const flow = model.flow
      if (!Flow.guards.EditingDelivery(flow) || !Work.guards.Deliver(flow.attempt.work)) {
        return { model }
      }
      const work = flow.attempt.work
      return Option.match(deliveryOf(flow.url, flow.note), {
        onNone: () => ({ model: withFlow(model, Flow.EditingDelivery({ ...flow, status: FormStatus.Invalid() })) }),
        onSome: (delivery) =>
          start(model, { work: Work.Deliver({ ...work, ...delivery }), signer: flow.attempt.signer }),
      })
    },
    ClickedApprove: ({ signer }) =>
      settledFlow(model.flow)
        ? { model: withFlow(model, Flow.ConfirmingApproval({ attempt: { work: Work.Approve(), signer } })) }
        : { model },
    ClickedConfirmApproval: () =>
      Flow.guards.ConfirmingApproval(model.flow) ? start(model, model.flow.attempt) : { model },
    ClickedReject: ({ signer }) =>
      settledFlow(model.flow)
        ? {
            model: withFlow(
              model,
              Flow.EditingRejection({
                attempt: { work: Work.Reject({ reason: '' }), signer },
                reason: '',
                status: FormStatus.Editing(),
              }),
            ),
          }
        : { model },
    UpdatedReason: ({ value }) =>
      Flow.guards.EditingRejection(model.flow)
        ? {
            model: withFlow(
              model,
              Flow.EditingRejection({ ...model.flow, reason: value, status: FormStatus.Editing() }),
            ),
          }
        : { model },
    SubmittedRejection: () => {
      const flow = model.flow
      if (!Flow.guards.EditingRejection(flow)) {
        return { model }
      }
      return Option.match(Schema.decodeUnknownOption(ReasonText)(flow.reason.trim()), {
        onNone: () => ({ model: withFlow(model, Flow.EditingRejection({ ...flow, status: FormStatus.Invalid() })) }),
        onSome: (reason) => start(model, { work: Work.Reject({ reason }), signer: flow.attempt.signer }),
      })
    },
    ClickedCancel: () => (cancellable(model.flow) ? { model: withFlow(model, Flow.Idle()) } : { model }),
  }) satisfies Group

/** A step waiting for the person, not for a Command: they may leave it. */
const cancellable = (flow: Flow): boolean =>
  isEditing(flow) || Flow.guards.WrongWallet(flow) || Flow.guards.Ready(flow) || settledFlow(flow)

const walletHandlers = (model: Model) =>
  ({
    ClickedTryAgain: () =>
      Flow.guards.WrongWallet(model.flow)
        ? { model: withFlow(model, Flow.Connecting({ attempt: model.flow.attempt })), commands: [ReadWalletAccount()] }
        : { model },
    SucceededReadWalletAccount: ({ connection }) => {
      const flow = model.flow
      if (!Flow.guards.Connecting(flow)) {
        return { model }
      }
      return sameAddress(connection.address, flow.attempt.signer)
        ? connected(model, flow.attempt, connection)
        : { model: withFlow(model, Flow.WrongWallet({ attempt: flow.attempt, connected: connection.address })) }
    },
    FailedReadWalletAccount: ({ problem }) =>
      Flow.guards.Connecting(model.flow)
        ? failed(model, stepOf(model.flow.attempt.work), MoneyFailure.Failed({ problem }))
        : { model },
    SucceededPublishEvent: ({ maybeDeliveryHash }) => {
      const flow = model.flow
      if (!Flow.guards.Publishing(flow)) {
        return { model }
      }
      const next: Connected = { ...flow.connected, maybeDeliveryHash }
      const step = stepOf(next.work)
      return {
        model: withFlow(model, Flow.Preparing({ connected: next })),
        commands: [
          PrepareSignature({ job: model.job, step: step === 'deliver' ? 'deliver' : 'reject', maybeDeliveryHash }),
        ],
      }
    },
    FailedPublishEvent: ({ failure }) =>
      Flow.guards.Publishing(model.flow)
        ? failed(model, stepOf(model.flow.connected.work), MoneyFailure.Unpublished({ failure }))
        : { model },
    SucceededPrepare: ({ typedData, maybeFunding }) =>
      Flow.guards.Preparing(model.flow)
        ? ready(model, { ...model.flow.connected, typedData, maybeFunding })
        : { model },
    FailedPrepare: ({ failure }) =>
      Flow.guards.Preparing(model.flow) ? failed(model, stepOf(model.flow.connected.work), failure) : { model },
    ClickedSwitchNetwork: () =>
      Flow.guards.Ready(model.flow)
        ? { model: withFlow(model, Flow.Switching({ prepared: model.flow.prepared })), commands: [SwitchNetwork()] }
        : { model },
    SucceededSwitchNetwork: ({ chainId }) =>
      Flow.guards.Switching(model.flow)
        ? ready(model, {
            ...model.flow.prepared,
            connection: { ...model.flow.prepared.connection, chainId },
          })
        : { model },
    FailedSwitchNetwork: ({ problem }) =>
      Flow.guards.Switching(model.flow)
        ? failed(model, stepOf(model.flow.prepared.work), MoneyFailure.Failed({ problem }))
        : { model },
    ClickedSign: () =>
      Flow.guards.Ready(model.flow) && onChain(model.flow.prepared) ? signing(model, model.flow.prepared) : { model },
    SucceededSign: ({ signature }) => {
      const flow = model.flow
      if (!Flow.guards.Signing(flow)) {
        return { model }
      }
      const { work, signer, maybeDeliveryHash } = flow.prepared
      return {
        model: withFlow(model, Flow.Submitting({ step: stepOf(work) })),
        commands: [Submit({ job: model.job, work, signer, signature, maybeDeliveryHash })],
      }
    },
    FailedSign: ({ problem }) =>
      Flow.guards.Signing(model.flow)
        ? failed(model, stepOf(model.flow.prepared.work), MoneyFailure.Failed({ problem }))
        : { model },
    SucceededSubmit: ({ transactionHash }) =>
      Flow.guards.Submitting(model.flow) ? following(model, model.flow.step, transactionHash, 0) : { model },
    FailedSubmit: ({ failure }) =>
      Flow.guards.Submitting(model.flow) ? failed(model, model.flow.step, failure) : { model },
  }) satisfies Group

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    ...readingHandlers(model),
    ...formHandlers(model),
    ...walletHandlers(model),
  })
