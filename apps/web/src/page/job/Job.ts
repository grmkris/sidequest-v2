import {
  type AccountId,
  type BidderJobView,
  type BuyerJobView,
  JobId,
  JobView,
  type Proposal,
  ProposalRef,
  type PublicJobView,
  WalletAddress,
} from '@sidequest/protocol'
import { Array, Effect, Option, Order, Schema } from 'effect'
import { AsyncData, Command, Subscription, Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'
import { SidequestClient } from '../../Api.ts'
import { Language } from '../../Language.ts'
import { Problem, problemOf } from '../../Problem.ts'
import type { Wallet } from '../../Wallet.ts'

type WalletAddress = typeof WalletAddress.Type
import * as Propose from './Propose.ts'
import * as Review from './Review.ts'
import * as Room from './Room.ts'
import * as Settlement from './Settlement.ts'

// The job page: the request and, for whoever is looking, their part of it. The buyer sees every proposal, accepts one
// exact version or asks for a change, then funds, approves or rejects; a bidder sees and revises their own proposals and,
// once they win, delivers; anyone else sees the request and may propose. The rooms sit beside it for its members.

// MODEL

const ViewData = AsyncData.Schema(JobView, Problem)

/** The buyer deciding on a proposal or on the request itself. */
export const Decision = defineTaggedUnion({
  Idle: {},
  ConfirmingAccept: { ref: ProposalRef },
  Accepting: { ref: ProposalRef },
  RequestingChange: { ref: ProposalRef },
  ConfirmingCancel: {},
  Cancelling: {},
  Failed: { problem: Problem },
})
export type Decision = typeof Decision.Type

export const Model = Schema.Struct({
  language: Language,
  job: JobId,
  maybeSigner: Schema.Option(WalletAddress),
  view: ViewData.schema,
  decision: Decision,
  maybePropose: Schema.Option(Propose.Model),
  room: Room.Model,
  maybeSettlement: Schema.Option(Settlement.Model),
  review: Review.Model,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  SucceededReadJob: { view: JobView },
  FailedReadJob: { problem: Problem },
  ClickedAccept: { ref: ProposalRef },
  ClickedConfirmAccept: {},
  ClickedRequestChange: { ref: ProposalRef },
  ClickedCancelRequest: {},
  ClickedConfirmCancel: {},
  ClickedKeep: {},
  SucceededDecide: {},
  FailedDecide: { problem: Problem },
  GotProposeMessage: { message: Propose.Message },
  GotRoomMessage: { message: Room.Message },
  GotSettlementMessage: { message: Settlement.Message },
  GotReviewMessage: { message: Review.Message },
})
export type Message = typeof Message.Type

// COMMAND

export const ReadJob = Command.define('ReadJob', {
  args: { job: JobId },
  messages: [Message.SucceededReadJob, Message.FailedReadJob],
  execute: ({ job }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      const view = yield* api.jobs.get({ params: { job } })
      return Message.SucceededReadJob({ view })
    }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedReadJob({ problem: problemOf(error) })))),
})

/** The buyer's decision on one exact proposal version: accept it, or ask its bidder for a change. */
export const Decide = Command.define('Decide', {
  args: { job: JobId, ref: ProposalRef, accept: Schema.Boolean },
  messages: [Message.SucceededDecide, Message.FailedDecide],
  execute: ({ job, ref, accept }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      yield* accept
        ? api.jobs.accept({ params: { job }, payload: ref })
        : api.jobs.requestChange({ params: { job }, payload: ref })
      return Message.SucceededDecide()
    }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedDecide({ problem: problemOf(error) })))),
})

export const CancelRequest = Command.define('CancelRequest', {
  args: { job: JobId },
  messages: [Message.SucceededDecide, Message.FailedDecide],
  execute: ({ job }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      yield* api.jobs.cancel({ params: { job } })
      return Message.SucceededDecide()
    }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedDecide({ problem: problemOf(error) })))),
})

// INIT

type Services = SidequestClient | Wallet
type UpdateReturn = Update.Return<Model, Message, Services>

export const init = (
  language: Language,
  job: JobId,
  maybeSigner: Option.Option<string>,
  mayReadRooms: boolean,
): UpdateReturn => {
  const roomInit = Update.foldChildInit(Room.init(language, job, mayReadRooms), {
    toParentModel: (room): Model => ({
      language,
      job,
      maybeSigner: Option.flatMap(maybeSigner, Schema.decodeUnknownOption(WalletAddress)),
      view: AsyncData.Loading(),
      decision: Decision.Idle(),
      maybePropose: Option.none(),
      room,
      maybeSettlement: Option.none(),
      review: Review.init(language, job),
    }),
    toParentMessage: (message) => Message.GotRoomMessage({ message }),
  })
  return { model: roomInit.model, commands: [ReadJob({ job }), ...(roomInit.commands ?? [])] }
}

// DERIVED

/** A bidder's proposals, newest version last. */
export const versionsOf = (proposals: ReadonlyArray<Proposal>, bidder: AccountId): ReadonlyArray<Proposal> =>
  Array.sort(
    Array.filter(proposals, (proposal) => proposal.bidder === bidder),
    Order.mapInput(Order.Number, (proposal: Proposal) => proposal.version),
  )

/** The newest version of a bidder's proposal. */
export const headOf = (proposals: ReadonlyArray<Proposal>, bidder: AccountId): Option.Option<Proposal> =>
  Array.last(versionsOf(proposals, bidder))

const settlingStates: ReadonlyArray<string> = ['Awarded', 'Funded', 'Delivered', 'Disputed', 'Settled']

/** A job as its audience sees it, one handler each. */
export const byAudience = <A>(
  view: JobView,
  cases: {
    readonly buyer: (buyer: BuyerJobView) => A
    readonly bidder: (bidder: BidderJobView) => A
    readonly public: (anyone: PublicJobView) => A
  },
): A =>
  view.audience === 'buyer'
    ? cases.buyer(view.view)
    : view.audience === 'bidder'
      ? cases.bidder(view.view)
      : cases.public(view.view)

const buyerSetup = (buyer: BuyerJobView, maybeSigner: Option.Option<WalletAddress>): Settlement.Setup => ({
  role: 'buyer',
  maybeSigner,
  maybeTerms: Option.map(Option.fromNullishOr(buyer.agreement), (agreement) => agreement.terms),
  maybeDeliveryUrl: Option.map(Option.fromNullishOr(buyer.delivery), (delivery) => delivery.url),
  maybeDisputeReason: Option.flatMap(Option.fromNullishOr(buyer.dispute), (dispute) =>
    Option.fromNullishOr(dispute.reason),
  ),
})

const workerSetup = (bidder: BidderJobView, maybeSigner: Option.Option<WalletAddress>): Settlement.Setup => ({
  role: 'worker',
  maybeSigner,
  maybeTerms: Option.map(Array.last(bidder.proposals), (proposal) => proposal.terms),
  maybeDeliveryUrl: Option.none(),
  maybeDisputeReason: Option.none(),
})

/** What the settlement panel needs from the job, for its buyer or its winning bidder; nothing for anyone else. */
const settlementSetup = (view: JobView, maybeSigner: Option.Option<WalletAddress>): Option.Option<Settlement.Setup> =>
  byAudience(view, {
    buyer: (buyer) =>
      settlingStates.includes(buyer.state) ? Option.some(buyerSetup(buyer, maybeSigner)) : Option.none(),
    bidder: (bidder) => (bidder.outcome === 'won' ? Option.some(workerSetup(bidder, maybeSigner)) : Option.none()),
    public: () => Option.none(),
  })

// UPDATE

type Step = Update.Step<Model, Message, Services>

const foldPropose = Update.foldChild({
  update: Propose.update,
  read: (model: Model) => model.maybePropose,
  write: (model: Model, nextPropose: Propose.Model) =>
    modifyFields(model, { maybePropose: () => Option.some(nextPropose) }),
  toParentMessage: (message) => Message.GotProposeMessage({ message }),
  foldOutMessage: Propose.OutMessage.match<Step>({
    Proposed: () => (model) => reread(modifyFields(model, { maybePropose: () => Option.none() })),
  }),
})

const roomFold = {
  read: (model: Model) => Option.some(model.room),
  write: (model: Model, nextRoom: Room.Model) => modifyFields(model, { room: () => nextRoom }),
  toParentMessage: (message: Room.Message) => Message.GotRoomMessage({ message }),
}
const foldRoom = Update.foldChild({ update: Room.update, ...roomFold })
const refreshRooms = Update.foldChildStep({ update: Room.refresh, ...roomFold })

const foldSettlement = Update.foldChild({
  update: Settlement.update,
  read: (model: Model) => model.maybeSettlement,
  write: (model: Model, nextSettlement: Settlement.Model) =>
    modifyFields(model, { maybeSettlement: () => Option.some(nextSettlement) }),
  toParentMessage: (message) => Message.GotSettlementMessage({ message }),
  foldOutMessage: Settlement.OutMessage.match<Step>({ ChainMoved: () => (model) => readAgain(model) }),
})

const foldReview = Update.foldChild({
  update: Review.update,
  read: (model: Model) => Option.some(model.review),
  write: (model: Model, nextReview: Review.Model) => modifyFields(model, { review: () => nextReview }),
  toParentMessage: (message) => Message.GotReviewMessage({ message }),
  foldOutMessage: Review.OutMessage.match<Step>({ Reviewed: () => (model) => readAgain(model) }),
})

/** Read the job again, keeping it on screen meanwhile. */
const readAgain: Step = (model) => ({
  model: modifyFields(model, { view: (view) => Option.getOrElse(AsyncData.revalidate(view), () => view) }),
  commands: [ReadJob({ job: model.job })],
})

/** After a change that may open a room (a proposal, an award): read the job and the rooms again. */
const reread: Step = (model) => Update.combine(model, [readAgain, refreshRooms])

/** Whether the person may propose: anyone on an open request who is not its buyer, or a bidder whose bid stands. */
const proposing = (view: JobView): boolean =>
  byAudience(view, {
    buyer: () => false,
    bidder: (bidder) => bidder.outcome === 'pending',
    public: (anyone) => anyone.state === 'Open',
  })

const withPropose = (model: Model, view: JobView): Model => {
  if (!proposing(view)) {
    return modifyFields(model, { maybePropose: () => Option.none() })
  }
  if (Option.isSome(model.maybePropose)) {
    return model
  }
  const fresh = Propose.init(model.language, model.job)
  const head = view.audience === 'bidder' ? Array.last(view.view.proposals) : Option.none()
  return modifyFields(model, {
    maybePropose: () =>
      Option.some(Option.match(head, { onNone: () => fresh, onSome: (proposal) => Propose.revising(fresh, proposal) })),
  })
}

const withSettlement = (model: Model, view: JobView): UpdateReturn =>
  Option.match(settlementSetup(view, model.maybeSigner), {
    onNone: () => ({ model: modifyFields(model, { maybeSettlement: () => Option.none() }) }),
    onSome: (setup) =>
      Option.match(model.maybeSettlement, {
        onSome: (settlement) => ({
          model: modifyFields(model, { maybeSettlement: () => Option.some(Settlement.informSetup(settlement, setup)) }),
        }),
        onNone: () =>
          Update.foldChildInit(Settlement.init(model.language, model.job, setup), {
            toParentModel: (settlement) => modifyFields(model, { maybeSettlement: () => Option.some(settlement) }),
            toParentMessage: (message) => Message.GotSettlementMessage({ message }),
          }),
      }),
  })

const decide = (model: Model, decision: Decision, command: Command.Command<Message, never, SidequestClient>) => ({
  model: modifyFields(model, { decision: () => decision }),
  commands: [command],
})

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    SucceededReadJob: ({ view }) =>
      withSettlement(withPropose(modifyFields(model, { view: () => ViewData.Success({ data: view }) }), view), view),
    FailedReadJob: ({ problem }) => ({
      model: modifyFields(model, { view: () => ViewData.Failure({ error: problem }) }),
    }),
    ClickedAccept: ({ ref }) => ({
      model: modifyFields(model, { decision: () => Decision.ConfirmingAccept({ ref }) }),
    }),
    ClickedConfirmAccept: () =>
      Decision.guards.ConfirmingAccept(model.decision)
        ? decide(
            model,
            Decision.Accepting({ ref: model.decision.ref }),
            Decide({ job: model.job, ref: model.decision.ref, accept: true }),
          )
        : { model },
    ClickedRequestChange: ({ ref }) =>
      decide(model, Decision.RequestingChange({ ref }), Decide({ job: model.job, ref, accept: false })),
    ClickedCancelRequest: () => ({ model: modifyFields(model, { decision: () => Decision.ConfirmingCancel() }) }),
    ClickedConfirmCancel: () => decide(model, Decision.Cancelling(), CancelRequest({ job: model.job })),
    ClickedKeep: () => ({ model: modifyFields(model, { decision: () => Decision.Idle() }) }),
    SucceededDecide: () => reread(modifyFields(model, { decision: () => Decision.Idle() })),
    FailedDecide: ({ problem }) => ({ model: modifyFields(model, { decision: () => Decision.Failed({ problem }) }) }),
    GotProposeMessage: ({ message: proposeMessage }) => foldPropose(model, proposeMessage),
    GotRoomMessage: ({ message: roomMessage }) => foldRoom(model, roomMessage),
    GotSettlementMessage: ({ message: settlementMessage }) => foldSettlement(model, settlementMessage),
    GotReviewMessage: ({ message: reviewMessage }) => foldReview(model, reviewMessage),
  })

/** The session became known or changed: the wallet that signs this person's steps. */
export const informSigner = (model: Model, maybeSigner: Option.Option<string>): Model => {
  const signer = Option.flatMap(maybeSigner, Schema.decodeUnknownOption(WalletAddress))
  return modifyFields(model, {
    maybeSigner: () => signer,
    maybeSettlement: Option.map((settlement) =>
      Settlement.informSetup(settlement, modifyFields(settlement.setup, { maybeSigner: () => signer })),
    ),
  })
}

// SUBSCRIPTION

export const subscriptions = Subscription.lift(Room.subscriptions)<Model, Message>({
  read: (model) => Option.some(model.room),
  toParentMessage: (message) => Message.GotRoomMessage({ message }),
})
