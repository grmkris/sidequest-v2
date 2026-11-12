import { format } from '@sidequest/i18n'
import {
  Amount,
  JobId,
  type Proposal,
  ProposalId,
  ProposalVersion,
  Terms,
  Text as TextSchema,
  UsdcOnArcTestnet,
} from '@sidequest/protocol'
import { Array, Clock, Effect, Option, Schema } from 'effect'
import { Command, type Html, Submodel, type Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'
import { editableUnits, formatUnits, parseUnits } from '../../Amount.ts'
import { SidequestClient } from '../../Api.ts'
import {
  DayChoice,
  dayChoiceOf,
  dayChoices,
  editedStatus,
  FormStatus,
  formProblem,
  shown,
  textError,
} from '../../Forms.ts'
import { Language } from '../../Language.ts'
import { Problem, problemOf } from '../../Problem.ts'
import { styled } from '../../Styled.ts'
import { say } from '../../Text.ts'
import * as Ui from '../../Ui.ts'
import * as s from '../../Ui.styles.ts'

// A bidder's proposal on an open request, or a new version of their own: the terms they offer, in USDC on Arc testnet.

// MODEL

/** The windows after a delivery, in days, within the escrow operator's bounds (review and dispute up to 14 days,
 * arbitration from 12 hours). */
export const WindowChoice = Schema.Literals(['1', '2', '3', '7', '14'])
export type WindowChoice = typeof WindowChoice.Type
const windowChoices: ReadonlyArray<WindowChoice> = ['1', '2', '3', '7', '14']

export const Model = Schema.Struct({
  language: Language,
  job: JobId,
  maybePrevious: Schema.Option(ProposalVersion),
  title: Schema.String,
  deliverables: Schema.String,
  amount: Schema.String,
  deliveryDays: DayChoice,
  reviewDays: WindowChoice,
  disputeDays: WindowChoice,
  arbitrationDays: WindowChoice,
  status: FormStatus,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  UpdatedTitle: { value: Schema.String },
  UpdatedDeliverables: { value: Schema.String },
  UpdatedAmount: { value: Schema.String },
  SelectedDeliveryDays: { value: Schema.String },
  SelectedReviewDays: { value: Schema.String },
  SelectedDisputeDays: { value: Schema.String },
  SelectedArbitrationDays: { value: Schema.String },
  SubmittedProposal: {},
  SucceededSubmitProposal: { proposal: ProposalId },
  FailedSubmitProposal: { problem: Problem },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({ Proposed: {} })
export type OutMessage = typeof OutMessage.Type

// COMMAND

const Offer = Schema.Struct({
  title: TextSchema(200),
  deliverables: Schema.NonEmptyArray(TextSchema(2000)),
  amount: Amount,
  deliveryDays: DayChoice,
  reviewDays: WindowChoice,
  disputeDays: WindowChoice,
  arbitrationDays: WindowChoice,
})
type Offer = typeof Offer.Type

const day = 86_400

/** Sends the offer as terms, its delivery deadline counted from when it is sent. */
export const SubmitProposal = Command.define('SubmitProposal', {
  args: { job: JobId, maybePrevious: Schema.Option(ProposalVersion), offer: Offer },
  messages: [Message.SucceededSubmitProposal, Message.FailedSubmitProposal],
  execute: ({ job, maybePrevious, offer }) =>
    Effect.gen(function* () {
      const now = Math.floor((yield* Clock.currentTimeMillis) / 1000)
      const terms = yield* Schema.decodeUnknownEffect(Terms)({
        title: offer.title,
        deliverables: offer.deliverables,
        amount: offer.amount,
        asset: UsdcOnArcTestnet.id,
        network: UsdcOnArcTestnet.network,
        deliveryDeadline: now + Number(offer.deliveryDays) * day,
        reviewWindowSeconds: Number(offer.reviewDays) * day,
        disputeWindowSeconds: Number(offer.disputeDays) * day,
        arbitrationWindowSeconds: Number(offer.arbitrationDays) * day,
        rail: 'escrow',
      })
      const api = yield* (yield* SidequestClient).api
      const { id } = yield* api.jobs.propose({
        params: { job },
        payload: Option.match(maybePrevious, {
          onNone: () => ({ terms }),
          onSome: (previous) => ({ previous, terms }),
        }),
      })
      return Message.SucceededSubmitProposal({ proposal: id })
    }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedSubmitProposal({ problem: problemOf(error) })))),
})

// INIT

export const init = (language: Language, job: JobId): Model => ({
  language,
  job,
  maybePrevious: Option.none(),
  title: '',
  deliverables: '',
  amount: '',
  deliveryDays: '7',
  reviewDays: '3',
  disputeDays: '2',
  arbitrationDays: '7',
  status: FormStatus.Editing(),
})

const windowDays = (seconds: number): WindowChoice =>
  Option.getOrElse(Schema.decodeUnknownOption(WindowChoice)(String(Math.round(seconds / day))), () => '3')

/** The form for a new version of `head`, filled in with its terms. */
export const revising = (model: Model, head: Proposal): Model =>
  modifyFields(model, {
    maybePrevious: () => Option.some(head.version),
    title: () => head.terms.title,
    deliverables: () => head.terms.deliverables.join('\n'),
    amount: () => editableUnits(head.terms.amount, UsdcOnArcTestnet.decimals, model.language),
    reviewDays: () => windowDays(head.terms.reviewWindowSeconds),
    disputeDays: () => windowDays(head.terms.disputeWindowSeconds),
    arbitrationDays: () => windowDays(head.terms.arbitrationWindowSeconds),
    status: () => FormStatus.Editing(),
  })

// CHECKS

const deliverablesOf = (text: string): ReadonlyArray<string> =>
  Array.filter(
    Array.map(text.split('\n'), (line) => line.trim()),
    (line) => line.length > 0,
  )

const amountOf = (model: Model): Option.Option<Amount> =>
  Option.filter(parseUnits(model.amount, UsdcOnArcTestnet.decimals, model.language), (amount) => amount !== '0')

const offerOf = (model: Model): Option.Option<Offer> =>
  Schema.decodeUnknownOption(Offer)({
    title: model.title.trim(),
    deliverables: deliverablesOf(model.deliverables),
    amount: Option.getOrUndefined(amountOf(model)),
    deliveryDays: model.deliveryDays,
    reviewDays: model.reviewDays,
    disputeDays: model.disputeDays,
    arbitrationDays: model.arbitrationDays,
  })

const deliverablesError = (model: Model): Option.Option<string> => {
  const lines = deliverablesOf(model.deliverables)
  if (lines.length === 0) {
    return Option.some(say(model.language, 'propose.deliverablesRequired'))
  }
  return lines.length > 50 || Array.some(lines, (line) => line.length > 2000)
    ? Option.some(say(model.language, 'propose.deliverablesTooMany'))
    : Option.none()
}

const amountError = (model: Model): Option.Option<string> =>
  Option.isSome(amountOf(model))
    ? Option.none()
    : Option.some(
        format(model.language, 'form.amount', {
          example: formatUnits('250500000', UsdcOnArcTestnet.decimals, model.language),
          decimals: UsdcOnArcTestnet.decimals,
        }),
      )

// UPDATE

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage, SidequestClient>

const selected = <A>(
  model: Model,
  value: string,
  decode: (value: string) => Option.Option<A>,
  write: (choice: A) => Model,
): UpdateReturn =>
  Option.match(decode(value), { onNone: () => ({ model }), onSome: (choice) => ({ model: write(choice) }) })

const windowOf = (value: string) => Schema.decodeUnknownOption(WindowChoice)(value)

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    UpdatedTitle: ({ value }) => ({ model: modifyFields(model, { title: () => value, status: editedStatus }) }),
    UpdatedDeliverables: ({ value }) => ({
      model: modifyFields(model, { deliverables: () => value, status: editedStatus }),
    }),
    UpdatedAmount: ({ value }) => ({ model: modifyFields(model, { amount: () => value, status: editedStatus }) }),
    SelectedDeliveryDays: ({ value }) =>
      selected(model, value, dayChoiceOf, (days) => modifyFields(model, { deliveryDays: () => days })),
    SelectedReviewDays: ({ value }) =>
      selected(model, value, windowOf, (days) => modifyFields(model, { reviewDays: () => days })),
    SelectedDisputeDays: ({ value }) =>
      selected(model, value, windowOf, (days) => modifyFields(model, { disputeDays: () => days })),
    SelectedArbitrationDays: ({ value }) =>
      selected(model, value, windowOf, (days) => modifyFields(model, { arbitrationDays: () => days })),
    SubmittedProposal: () =>
      FormStatus.guards.Submitting(model.status)
        ? { model }
        : Option.match(offerOf(model), {
            onNone: () => ({ model: modifyFields(model, { status: () => FormStatus.Invalid() }) }),
            onSome: (offer) => ({
              model: modifyFields(model, { status: () => FormStatus.Submitting() }),
              commands: [SubmitProposal({ job: model.job, maybePrevious: model.maybePrevious, offer })],
            }),
          }),
    SucceededSubmitProposal: () => ({
      model: modifyFields(model, { status: () => FormStatus.Editing() }),
      outMessage: OutMessage.Proposed(),
    }),
    FailedSubmitProposal: ({ problem }) => ({
      model: modifyFields(model, { status: () => FormStatus.Failed({ problem }) }),
    }),
  })

// VIEW

const dayOptions = (language: Language, choices: ReadonlyArray<string>) =>
  choices.map((days) => ({ value: days, label: format(language, 'form.days', { count: Number(days) }) }))

const windows = (h: Html.HtmlBuilder<Message>, model: Model) =>
  h.div(styled(h, s.fieldRow()), [
    Ui.selectField(h, {
      id: 'proposal-delivery',
      label: say(model.language, 'propose.deliveryIn'),
      value: model.deliveryDays,
      options: dayOptions(model.language, dayChoices),
      onChange: (value) => Message.SelectedDeliveryDays({ value }),
    }),
    Ui.selectField(h, {
      id: 'proposal-review',
      label: say(model.language, 'terms.review'),
      value: model.reviewDays,
      options: dayOptions(model.language, windowChoices),
      onChange: (value) => Message.SelectedReviewDays({ value }),
    }),
    Ui.selectField(h, {
      id: 'proposal-dispute',
      label: say(model.language, 'terms.dispute'),
      value: model.disputeDays,
      options: dayOptions(model.language, windowChoices),
      onChange: (value) => Message.SelectedDisputeDays({ value }),
    }),
    Ui.selectField(h, {
      id: 'proposal-arbitration',
      label: say(model.language, 'terms.arbitration'),
      value: model.arbitrationDays,
      options: dayOptions(model.language, windowChoices),
      onChange: (value) => Message.SelectedArbitrationDays({ value }),
    }),
  ])

export const view = Submodel.defineView<Model, Message>((model, h) => {
  const language = model.language
  return h.form(
    [h.OnSubmit(Message.SubmittedProposal()), h.Novalidate(true), ...styled(h, s.form())],
    [
      Ui.textField(h, {
        id: 'proposal-title',
        label: say(language, 'propose.titleLabel'),
        value: model.title,
        onInput: (value) => Message.UpdatedTitle({ value }),
        error: shown(model.status, textError(model.title, 200, language)),
        required: true,
      }),
      Ui.textArea(h, {
        id: 'proposal-deliverables',
        label: say(language, 'propose.deliverablesLabel'),
        hint: say(language, 'propose.deliverablesHint'),
        value: model.deliverables,
        onInput: (value) => Message.UpdatedDeliverables({ value }),
        error: shown(model.status, deliverablesError(model)),
        required: true,
      }),
      Ui.textField(h, {
        id: 'proposal-amount',
        label: say(language, 'propose.amountLabel'),
        hint: say(language, 'propose.amountHint'),
        value: model.amount,
        inputMode: 'decimal',
        onInput: (value) => Message.UpdatedAmount({ value }),
        error: shown(model.status, amountError(model)),
        required: true,
      }),
      windows(h, model),
      h.p(styled(h, s.hint()), [say(language, 'propose.windowsHint')]),
      Ui.maybeProblem(h, language, formProblem(model.status)),
      h.div(styled(h, s.actions()), [
        Ui.submit(h, {
          label: Option.match(model.maybePrevious, {
            onNone: () => say(language, 'propose.submit'),
            onSome: (previous) => format(language, 'propose.submitVersion', { version: previous + 1 }),
          }),
          busy: FormStatus.guards.Submitting(model.status),
        }),
      ]),
    ],
  )
})
