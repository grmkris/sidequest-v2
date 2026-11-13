import { JobView, type ProposalView } from '@sidequest/fold'
import { NetworkRef, WalletAddress } from '@sidequest/protocol'
import { Array, Effect, Option, Schema } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import { AsyncData, Command, Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'
import { SidequestClient } from '../../Api.ts'
import { Language } from '../../Language.ts'
import { Me, pubkeyOf, walletOn } from '../../Me.ts'
import { defineReadNames, Names, unnamed, withNames } from '../../Names.ts'
import type { Preload } from '../../Preload.ts'
import { failedWith, Problem } from '../../Problem.ts'
import { PublishFailure, publishEvent, publishFailureOf } from '../../Publishing.ts'
import type { Signers } from '../../Signer.ts'
import { say } from '../../Text.ts'
import type { Wallet } from '../../Wallet.ts'
import * as Money from './money/message.ts'
import * as MoneyUpdate from './money/update.ts'
import * as Propose from './Propose.ts'
import * as Review from './Review.ts'

// The job page: a request and everything signed about it, as the index folds it (`@sidequest/fold`'s `JobView`). Before
// funding nothing binds: a bidder with a linked wallet proposes, revises and withdraws; the buyer accepts one proposal
// or closes the request. Each is a signed event the person's signer makes; the page then reads the job again. The money
// steps (fund, deliver, approve, reject) are wallet signatures the API relays (`Money.ts`); once the job settled, each
// side may review the other.

// MODEL

const ViewData = AsyncData.Schema(JobView, Problem)

/** What the person publishes about the job. */
export const Act = Schema.Literals(['proposal', 'accept', 'withdraw', 'close', 'review'])
export type Act = typeof Act.Type

/** What the person is doing, one thing at a time. */
export const Action = defineTaggedUnion({
  Idle: {},
  ConfirmingAccept: { proposal: Schema.String },
  ConfirmingClose: {},
  Publishing: { act: Act },
  Published: { act: Act },
  Failed: { failure: PublishFailure },
})
export type Action = typeof Action.Type

export const Model = Schema.Struct({
  language: Language,
  job: Schema.String,
  me: Me,
  view: ViewData.schema,
  action: Action,
  maybePropose: Schema.Option(Propose.Model),
  money: Money.Model,
  review: Review.Model,
  names: Names,
  askedNames: Schema.Array(Schema.String),
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  SucceededReadJob: { view: JobView },
  FailedReadJob: { problem: Problem },
  ClickedPropose: {},
  ClickedRevise: { proposal: Schema.String },
  ClickedCancelPropose: {},
  GotProposeMessage: { message: Propose.Message },
  GotMoneyMessage: { message: Money.Message },
  ClickedFund: { proposal: Schema.String, payer: WalletAddress },
  GotReviewMessage: { message: Review.Message },
  ClickedWithdraw: { proposal: Schema.String },
  ClickedAccept: { proposal: Schema.String },
  ClickedConfirmAccept: {},
  ClickedClose: {},
  ClickedConfirmClose: {},
  ClickedKeep: {},
  SucceededPublish: { act: Act },
  FailedPublish: { failure: PublishFailure },
  SucceededReadNames: { names: Names },
  FailedReadNames: { problem: Problem },
})
export type Message = typeof Message.Type

/** The person acted without a signer ready: the site sends them to set one up, and back. */
export const OutMessage = defineMessageUnion({ SignerMissing: {} })
export type OutMessage = typeof OutMessage.Type

// COMMAND

/** The job as the index folds it; `fresh` right after the person published about it, past what the browser's cache
 * kept (the index lets caches keep a job for seconds). */
export const ReadJob = Command.define('ReadJob', {
  args: { job: Schema.String, fresh: Schema.Boolean },
  messages: [Message.SucceededReadJob, Message.FailedReadJob],
  execute: ({ job, fresh }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      const view = yield* api.indexJobs
        .job({ params: { id: job } })
        .pipe(Effect.provideService(FetchHttpClient.RequestInit, fresh ? { cache: 'no-cache' } : {}))
      return Message.SucceededReadJob({ view })
    }).pipe(Effect.catch(failedWith(Message.FailedReadJob))),
})

const published = (act: Act) =>
  Effect.matchEffect({
    onSuccess: () => Effect.succeed(Message.SucceededPublish({ act })),
    onFailure: (error: unknown) => Effect.succeed(Message.FailedPublish({ failure: publishFailureOf(error) })),
  })

/** A bidder's proposal for the job, paid to their linked wallet: the terms as of signing, standing for the days they
 * chose; `previous` names the proposal it revises. */
export const PublishProposal = Command.define('PublishProposal', {
  args: {
    job: Schema.String,
    buyer: Schema.String,
    payTo: Schema.String,
    offer: Propose.Offer,
    maybePrevious: Schema.Option(Schema.String),
  },
  messages: [Message.SucceededPublish, Message.FailedPublish],
  execute: ({ job, buyer, payTo, offer, maybePrevious }) =>
    publishEvent((kit, createdAt) =>
      Propose.termsOf(offer, createdAt).pipe(
        Effect.flatMap((terms) =>
          kit.proposalTemplate(
            {
              job,
              buyer,
              terms,
              payTo,
              validUntil: Propose.validUntilOf(offer, createdAt),
              ...Option.match(maybePrevious, { onNone: () => ({}), onSome: (previous) => ({ previous }) }),
            },
            createdAt,
          ),
        ),
        Effect.orElseSucceed(() => Option.none()),
      ),
    ).pipe(published('proposal')),
})

/** The buyer accepts one proposal: its exact terms by digest, on its network. A signal; only funding binds. */
export const PublishAccept = Command.define('PublishAccept', {
  args: {
    job: Schema.String,
    proposal: Schema.String,
    termsDigest: Schema.String,
    worker: Schema.String,
    network: NetworkRef,
  },
  messages: [Message.SucceededPublish, Message.FailedPublish],
  execute: (accept) =>
    publishEvent((kit, createdAt) => kit.acceptTemplate(accept, createdAt)).pipe(published('accept')),
})

/** A statement on the record: a bidder withdrawing their proposal, or the buyer closing the request. */
export const PublishStatement = Command.define('PublishStatement', {
  args: {
    job: Schema.String,
    maybeAbout: Schema.Option(Schema.String),
    type: Schema.Literals(['withdraw_request', 'withdraw_proposal']),
    text: Schema.String,
  },
  messages: [Message.SucceededPublish, Message.FailedPublish],
  execute: ({ job, maybeAbout, type, text }) =>
    publishEvent((kit, createdAt) =>
      kit.statementTemplate(
        {
          job,
          type,
          text,
          ...Option.match(maybeAbout, { onNone: () => ({}), onSome: (about) => ({ about }) }),
        },
        createdAt,
      ),
    ).pipe(published(type === 'withdraw_request' ? 'close' : 'withdraw')),
})

/** One side's review of the other, once the job settled. */
export const PublishReview = Command.define('PublishReview', {
  args: { job: Schema.String, subject: Schema.String, rating: Schema.Int, text: Schema.String },
  messages: [Message.SucceededPublish, Message.FailedPublish],
  execute: (review) =>
    publishEvent((kit, createdAt) => kit.reviewTemplate(review, createdAt)).pipe(published('review')),
})

export const ReadNames = defineReadNames(Message.SucceededReadNames, Message.FailedReadNames)

// INIT

type Services = SidequestClient | Signers | Wallet
type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage, Services>
type Step = Update.StepWithOutMessage<Model, Message, OutMessage, Services>

type JobPreload = Extract<Preload, { readonly _tag: 'Job' }>

/** Every key the job shows: its buyer, the bidders and whoever signed an accept, a statement or a review. */
export const keysIn = (view: JobView): ReadonlyArray<string> => [
  view.buyer,
  ...Array.map(view.proposals, (proposal) => proposal.author),
  ...Array.map(view.accepts, (accept) => accept.author),
  ...Array.map(view.statements, (statement) => statement.author),
  ...Array.map(view.reviews, (review) => review.author),
]

const toMoneyMessage = (message: Money.Message) => Message.GotMoneyMessage({ message })

/** Once the chain funded the job: read its payment, for the escrow's address and the relayed transactions. */
const paymentReads = (job: string, view: JobView) =>
  view.funding === null ? [] : Command.mapMessages([MoneyUpdate.ReadPayment({ job })], toMoneyMessage)

/** The job as the server read it, or a read of it. */
export const init = (
  language: Language,
  job: string,
  me: Me,
  maybePreload: Option.Option<JobPreload>,
): Update.Return<Model, Message, Services> => {
  const base = {
    language,
    job,
    me,
    action: Action.Idle(),
    maybePropose: Option.none(),
    money: MoneyUpdate.init(language, job),
    review: Review.init(language),
  }
  return Option.match(
    Option.filter(maybePreload, (preload) => preload.view.job === job),
    {
      onSome: ({ view, names }) => ({
        // The server asked for every name its view shows; one it did not find is not asked for again.
        model: { ...base, view: ViewData.Success({ data: view }), names, askedNames: keysIn(view) },
        commands: paymentReads(job, view),
      }),
      onNone: () => ({
        model: { ...base, view: AsyncData.Loading(), names: [], askedNames: [] },
        commands: [ReadJob({ job, fresh: false })],
      }),
    },
  )
}

// DERIVED

/** Before funding, the job still takes proposals, accepts and statements. */
export const negotiable = (view: JobView): boolean =>
  view.stage === 'open' || view.stage === 'proposed' || view.stage === 'accepted'

/** A proposal that still stands: not revised, withdrawn, expired or addressed to someone else. */
export const standing = (proposal: ProposalView): boolean =>
  !proposal.superseded && !proposal.withdrawn && !proposal.expired && !proposal.otherBuyer

/** Whether the person is the job's buyer: their signer's key wrote the request. */
export const isBuyer = (model: Model, view: JobView): boolean => isMine(model, view.buyer)

/** Whether `pubkey` is the person's own key. */
export const isMine = (model: Model, pubkey: string): boolean => Option.contains(pubkeyOf(model.me), pubkey)

/** The person's verified wallet on the network proposals are paid on, which their proposal names. */
export const payToOf = (model: Model): Option.Option<string> => walletOn(model.me, Propose.proposalNetwork)

const proposalOf = (model: Model, id: string): Option.Option<ProposalView> =>
  Option.flatMap(AsyncData.getData(model.view), (view) =>
    Array.findFirst(view.proposals, (proposal) => proposal.id === id),
  )

// UPDATE

const withAction = (model: Model, action: Action): Model => modifyFields(model, { action: () => action })

const busy = (model: Model): boolean => Action.guards.Publishing(model.action)

/** Only a person whose signer is ready acts, one thing at a time; without a signer the site sends them to set one up. */
const asSigner = (model: Model, act: (pubkey: string) => UpdateReturn): UpdateReturn => {
  if (busy(model)) {
    return { model }
  }
  return Option.match(pubkeyOf(model.me), {
    onNone: () => ({ model, outMessage: OutMessage.SignerMissing() }),
    onSome: act,
  })
}

const publishing = (model: Model, act: Act, command: Command.Command<Message, never, Services>): UpdateReturn => ({
  model: withAction(model, Action.Publishing({ act })),
  commands: [command],
})

const submittedProposal = (model: Model, offer: Propose.Offer, maybePrevious: Option.Option<string>): UpdateReturn =>
  asSigner(model, () =>
    Option.match(Option.all({ view: AsyncData.getData(model.view), payTo: payToOf(model) }), {
      onNone: () => ({ model: modifyFields(model, { maybePropose: Option.map(Propose.settled) }) }),
      onSome: ({ view, payTo }) =>
        publishing(
          model,
          'proposal',
          PublishProposal({ job: model.job, buyer: view.buyer, payTo, offer, maybePrevious }),
        ),
    }),
  )

const foldPropose = Update.foldChild({
  update: Propose.update,
  read: (model: Model) => model.maybePropose,
  write: (model: Model, nextPropose: Propose.Model) =>
    modifyFields(model, { maybePropose: () => Option.some(nextPropose) }),
  toParentMessage: (message) => Message.GotProposeMessage({ message }),
  foldOutMessage: Propose.OutMessage.match<Step>({
    Submitted:
      ({ offer, maybePrevious }) =>
      (model) =>
        submittedProposal(model, offer, maybePrevious),
  }),
})

/** Read the job again past the cache, keeping it on screen meanwhile. */
const readAgain = (model: Model): UpdateReturn => ({
  model: modifyFields(model, { view: (view) => Option.getOrElse(AsyncData.revalidate(view), () => view) }),
  commands: [ReadJob({ job: model.job, fresh: true })],
})

/** After the job was read, ask for the names of the keys not known or asked for yet. */
const askNames = (model: Model, view: JobView): UpdateReturn =>
  Array.match(unnamed(keysIn(view), model.names, model.askedNames), {
    onEmpty: () => ({ model }),
    onNonEmpty: (pubkeys) => ({
      model: modifyFields(model, { askedNames: Array.appendAll(pubkeys) }),
      commands: [ReadNames({ pubkeys })],
    }),
  })

/** The job as read: shown, with the names it needs asked for. */
const jobRead = (model: Model, view: JobView): UpdateReturn =>
  askNames(modifyFields(model, { view: () => ViewData.Success({ data: view }) }), view)

const moneyFold = {
  read: (model: Model) => Option.some(model.money),
  write: (model: Model, nextMoney: Money.Model) => modifyFields(model, { money: () => nextMoney }),
  toParentMessage: toMoneyMessage,
  foldOutMessage: Money.OutMessage.match<Step>({
    ReadJob:
      ({ view }) =>
      (model) =>
        jobRead(model, view),
  }),
}

const foldMoney = Update.foldChild({ update: MoneyUpdate.update, ...moneyFold })

const foldFund = Update.foldChild({ update: MoneyUpdate.fund, ...moneyFold })

/** The other side of a settled job, whom the person's review is about. */
export const reviewSubject = (model: Model, view: JobView): Option.Option<string> => {
  if (isBuyer(model, view)) {
    return Option.fromNullishOr(view.worker)
  }
  return Option.exists(Option.fromNullishOr(view.worker), (worker) => isMine(model, worker))
    ? Option.some(view.buyer)
    : Option.none()
}

const foldReview = Update.foldChild({
  update: Review.update,
  read: (model: Model) => Option.some(model.review),
  write: (model: Model, nextReview: Review.Model) => modifyFields(model, { review: () => nextReview }),
  toParentMessage: (message) => Message.GotReviewMessage({ message }),
  foldOutMessage: Review.OutMessage.match<Step>({
    Submitted:
      ({ rating, text }) =>
      (model) =>
        asSigner(model, () =>
          Option.match(
            Option.flatMap(AsyncData.getData(model.view), (view) => reviewSubject(model, view)),
            {
              onNone: () => ({ model: modifyFields(model, { review: Review.settled }) }),
              onSome: (subject) =>
                publishing(model, 'review', PublishReview({ job: model.job, subject, rating, text })),
            },
          ),
        ),
  }),
})

const confirmedAccept = (model: Model): UpdateReturn => {
  const action = model.action
  if (!Action.guards.ConfirmingAccept(action)) {
    return { model }
  }
  return asSigner(model, () =>
    Option.match(proposalOf(model, action.proposal), {
      onNone: () => ({ model: withAction(model, Action.Idle()) }),
      onSome: (proposal) =>
        publishing(
          model,
          'accept',
          PublishAccept({
            job: model.job,
            proposal: proposal.id,
            termsDigest: proposal.content.termsDigest,
            worker: proposal.author,
            network: proposal.content.terms.network,
          }),
        ),
    }),
  )
}

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    SucceededReadJob: ({ view }) => {
      const read = jobRead(model, view)
      return { ...read, commands: [...(read.commands ?? []), ...paymentReads(model.job, view)] }
    },
    FailedReadJob: ({ problem }) => ({
      model: modifyFields(model, { view: () => ViewData.Failure({ error: problem }) }),
    }),
    ClickedPropose: () =>
      asSigner(model, () => ({
        model: modifyFields(model, { maybePropose: () => Option.some(Propose.init(model.language)) }),
      })),
    ClickedRevise: ({ proposal }) =>
      asSigner(model, () => ({
        model: modifyFields(model, {
          maybePropose: () =>
            Option.map(proposalOf(model, proposal), (shown) => Propose.revising(model.language, shown)),
        }),
      })),
    ClickedCancelPropose: () => ({ model: modifyFields(model, { maybePropose: () => Option.none() }) }),
    GotProposeMessage: ({ message: proposeMessage }) => foldPropose(model, proposeMessage),
    GotMoneyMessage: ({ message: moneyMessage }) => foldMoney(model, moneyMessage),
    ClickedFund: (funding) => foldFund(model, funding),
    GotReviewMessage: ({ message: reviewMessage }) => foldReview(model, reviewMessage),
    ClickedWithdraw: ({ proposal }) =>
      asSigner(model, () =>
        publishing(
          model,
          'withdraw',
          PublishStatement({
            job: model.job,
            maybeAbout: Option.some(proposal),
            type: 'withdraw_proposal',
            text: say(model.language, 'job.withdrawStatement'),
          }),
        ),
      ),
    ClickedAccept: ({ proposal }) =>
      asSigner(model, () => ({ model: withAction(model, Action.ConfirmingAccept({ proposal })) })),
    ClickedConfirmAccept: () => confirmedAccept(model),
    ClickedClose: () => asSigner(model, () => ({ model: withAction(model, Action.ConfirmingClose()) })),
    ClickedConfirmClose: () =>
      Action.guards.ConfirmingClose(model.action)
        ? asSigner(model, () =>
            publishing(
              model,
              'close',
              PublishStatement({
                job: model.job,
                maybeAbout: Option.none(),
                type: 'withdraw_request',
                text: say(model.language, 'job.closeStatement'),
              }),
            ),
          )
        : { model },
    ClickedKeep: () => ({ model: withAction(model, Action.Idle()) }),
    SucceededPublish: ({ act }) =>
      readAgain(
        modifyFields(model, {
          action: () => Action.Published({ act }),
          maybePropose: (maybePropose) => (act === 'proposal' ? Option.none() : maybePropose),
          review: (review) => (act === 'review' ? Review.init(model.language) : review),
        }),
      ),
    FailedPublish: ({ failure }) => ({
      model: modifyFields(model, {
        action: () => Action.Failed({ failure }),
        maybePropose: Option.map(Propose.settled),
        review: Review.settled,
      }),
    }),
    SucceededReadNames: ({ names }) => ({ model: modifyFields(model, { names: (known) => withNames(known, names) }) }),
    FailedReadNames: () => ({ model }),
  })
