import { SignedEvent } from '@sidequest/protocol'
import { Effect, Option, Schema } from 'effect'
import { Command, type Html, Submodel, type Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'
import { SidequestClient } from '../../Api.ts'
import { formatAmount } from '../../Amount.ts'
import { Language } from '../../Language.ts'
import { type Names, nameOf } from '../../Names.ts'
import { nowSeconds, PublishFailure, publishFailureNotice, publishFailureOf } from '../../Publishing.ts'
import { type PrivateProposal, Rooms, RoomsFailed, RoomsFailure } from '../../Rooms.ts'
import { Signers } from '../../Signer.ts'
import { styled } from '../../Styled.ts'
import { formatInstant, say } from '../../Text.ts'
import * as Ui from '../../Ui.ts'
import * as s from '../../Ui.styles.ts'
import * as js from './Job.styles.ts'
import * as Propose from './Propose.ts'

// Private proposals (ADR-0003, decision 6): a bidder may send their signed proposal only into their room with the
// buyer instead of publishing it. The buyer's page verifies it there and shows it among the proposals, labelled
// private. Funding needs the proposal in the index, so the buyer may publish that very signed event, after saying yes
// to it becoming public; until then Sidequest's server never sees it.

// MODEL

export const Action = defineTaggedUnion({
  Idle: {},
  Sending: {},
  Sent: {},
  SendFailed: { reason: RoomsFailure },
  Confirming: { proposal: Schema.String },
  Publishing: { proposal: Schema.String },
  PublishFailed: { failure: PublishFailure },
})
export type Action = typeof Action.Type

export const Model = Schema.Struct({ language: Language, action: Action })
export type Model = typeof Model.Type

export const init = (language: Language): Model => ({ language, action: Action.Idle() })

// MESSAGE

export const Message = defineMessageUnion({
  SucceededSend: {},
  FailedSend: { reason: RoomsFailure },
  ClickedPublish: { proposal: Schema.String },
  ClickedConfirm: { event: Schema.String },
  ClickedCancel: {},
  SucceededPublish: {},
  FailedPublish: { failure: PublishFailure },
})
export type Message = typeof Message.Type

/** The proposal went into the room (read the rooms again), or became public (read the job again). */
export const OutMessage = defineMessageUnion({ Sent: {}, Published: {} })
export type OutMessage = typeof OutMessage.Type

// COMMAND

class Unbuildable extends Schema.TaggedError<Unbuildable>()('Unbuildable', {}) {}

/** The bidder's proposal, signed as it would be published, sent only into their room with the buyer. */
export const SendPrivately = Command.define('SendPrivately', {
  args: { job: Schema.String, buyer: Schema.String, payTo: Schema.String, offer: Propose.Offer },
  messages: [Message.SucceededSend, Message.FailedSend],
  execute: ({ job, buyer, payTo, offer }) =>
    Effect.gen(function* () {
      const signers = yield* Signers
      const kit = yield* signers.kit
      const createdAt = yield* nowSeconds
      const terms = yield* Propose.termsOf(offer, createdAt)
      const validUntil = Propose.validUntilOf(offer, createdAt)
      const template = yield* kit.proposalTemplate({ job, buyer, terms, payTo, validUntil }, createdAt)
      if (Option.isNone(template)) return yield* new Unbuildable()
      const event = yield* (yield* signers.resume).signEvent(template.value)
      yield* (yield* Rooms).sendProposal(job, buyer, event)
      return Message.SucceededSend()
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(Message.FailedSend({ reason: error instanceof RoomsFailed ? error.reason : 'failed' })),
      ),
    ),
})

const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(SignedEvent))

/** The private proposal's own signed event, through the index: it becomes public, and fundable. */
export const PublishPrivate = Command.define('PublishPrivate', {
  args: { event: Schema.String },
  messages: [Message.SucceededPublish, Message.FailedPublish],
  execute: ({ event }) =>
    Effect.gen(function* () {
      const payload = yield* decodeEvent(event)
      const api = yield* (yield* SidequestClient).api
      yield* api.events.publish({ payload })
      return Message.SucceededPublish()
    }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedPublish({ failure: publishFailureOf(error) })))),
})

// UPDATE

type Services = Signers | Rooms | SidequestClient
type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage, Services>

const withAction = (model: Model, action: Action): Model => modifyFields(model, { action: () => action })

/** The bidder chose to keep this proposal private: it is signed and sent into the room. */
export const sendPrivately = (
  model: Model,
  args: { readonly job: string; readonly buyer: string; readonly payTo: string; readonly offer: Propose.Offer },
): UpdateReturn =>
  Action.guards.Sending(model.action)
    ? { model }
    : { model: withAction(model, Action.Sending()), commands: [SendPrivately(args)] }

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    SucceededSend: () => ({ model: withAction(model, Action.Sent()), outMessage: OutMessage.Sent() }),
    FailedSend: ({ reason }) => ({ model: withAction(model, Action.SendFailed({ reason })) }),
    ClickedPublish: ({ proposal }) => ({ model: withAction(model, Action.Confirming({ proposal })) }),
    ClickedConfirm: ({ event }) =>
      Action.guards.Confirming(model.action)
        ? {
            model: withAction(model, Action.Publishing({ proposal: model.action.proposal })),
            commands: [PublishPrivate({ event })],
          }
        : { model },
    ClickedCancel: () => ({ model: withAction(model, Action.Idle()) }),
    SucceededPublish: () => ({ model: withAction(model, Action.Idle()), outMessage: OutMessage.Published() }),
    FailedPublish: ({ failure }) => ({ model: withAction(model, Action.PublishFailed({ failure })) }),
  })

// VIEW

/** What the job page tells the private proposals: the ones its rooms hold, whether the person may publish them (the
 * buyer), the names it knows, the time zone, and where to set up a signer. */
export type ViewInputs = {
  readonly proposals: ReadonlyArray<PrivateProposal>
  readonly buyer: boolean
  readonly names: Names
  readonly timeZone: string
  readonly identityHref: string
}

type H = Html.HtmlBuilder<Message>

const publishControls = (h: H, model: Model, proposal: PrivateProposal) => {
  const action = model.action
  if (Action.guards.Confirming(action) && action.proposal === proposal.id) {
    return h.div(
      [h.Role('group'), ...styled(h, js.slip())],
      [
        h.p([], [say(model.language, 'private.consent')]),
        h.div(styled(h, s.actions()), [
          Ui.button(h, {
            label: say(model.language, 'private.confirm'),
            onClick: Message.ClickedConfirm({ event: proposal.event }),
            kind: 'primary',
          }),
          Ui.button(h, { label: say(model.language, 'common.cancel'), onClick: Message.ClickedCancel() }),
        ]),
      ],
    )
  }
  return h.div(styled(h, s.actions()), [
    Ui.button(h, {
      label: say(model.language, 'private.publish'),
      onClick: Message.ClickedPublish({ proposal: proposal.id }),
      busy: Action.guards.Publishing(action) && action.proposal === proposal.id,
    }),
  ])
}

const card = (h: H, model: Model, inputs: ViewInputs, proposal: PrivateProposal) =>
  h.keyed('article')(proposal.id, styled(h, s.panel()), [
    h.header(styled(h, s.sectionHead()), [
      h.h3([], [nameOf(inputs.names, proposal.author)]),
      Ui.chip(h, say(model.language, 'private.label'), 'seal'),
    ]),
    h.h4(styled(h, js.versionTitle()), [proposal.title]),
    h.p(styled(h, js.amount()), [formatAmount(proposal.amount, proposal.asset, model.language)]),
    h.p(styled(h, s.meta()), [
      say(model.language, 'private.deadline'),
      ' ',
      formatInstant(proposal.deliveryDeadline, model.language, inputs.timeZone),
    ]),
    h.p(styled(h, s.meta()), [say(model.language, 'private.note')]),
    inputs.buyer ? publishControls(h, model, proposal) : h.empty,
  ])

const notice = (h: H, model: Model, identityHref: string) =>
  Action.match(model.action, {
    Idle: () => h.empty,
    Confirming: () => h.empty,
    Publishing: () => Ui.waiting(h, say(model.language, 'private.publishing')),
    Sending: () => Ui.waiting(h, say(model.language, 'private.sending')),
    Sent: () => Ui.notice(h, 'done', [h.p([], [say(model.language, 'private.sent')])]),
    SendFailed: () => Ui.notice(h, 'danger', [h.p([], [say(model.language, 'private.sendFailed')])]),
    PublishFailed: ({ failure }) => publishFailureNotice(h, model.language, failure, identityHref),
  })

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) =>
  h.div(styled(h, s.section()), [
    notice(h, model, inputs.identityHref),
    ...inputs.proposals.map((proposal) => card(h, model, inputs, proposal)),
  ]),
)
