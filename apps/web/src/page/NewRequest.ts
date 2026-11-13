import { format } from '@sidequest/i18n'
import { Text } from '@sidequest/protocol'
import { Effect, Option, Schema } from 'effect'
import { Command, type Html, Submodel, type Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'
import type { SidequestClient } from '../Api.ts'
import { DayChoice, dayChoiceOf, dayChoices, editedStatus, FormStatus, shown, textError } from '../Forms.ts'
import { signerOnly } from '../Gate.ts'
import { Language } from '../Language.ts'
import { Me } from '../Me.ts'
import { PublishFailure, publishEvent, publishFailureNotice, publishFailureOf } from '../Publishing.ts'
import { AppRoute, identityHref } from '../route.ts'
import type { Signers } from '../Signer.ts'
import { styled } from '../Styled.ts'
import { say } from '../Text.ts'
import * as Ui from '../Ui.ts'
import * as s from '../Ui.styles.ts'

// A buyer posts a work request: a signed job-request event, whose id becomes the job's id and the job page's address.
// Anyone with a Nostr signer may post one; a proposal for it, not the request, needs a linked wallet.

// MODEL

export const Model = Schema.Struct({
  language: Language,
  me: Me,
  title: Schema.String,
  description: Schema.String,
  days: DayChoice,
  status: FormStatus,
  maybeFailure: Schema.Option(PublishFailure),
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  UpdatedTitle: { value: Schema.String },
  UpdatedDescription: { value: Schema.String },
  SelectedDays: { value: Schema.String },
  SubmittedRequest: {},
  SucceededPublishRequest: { job: Schema.String },
  FailedPublishRequest: { failure: PublishFailure },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({ Posted: { job: Schema.String }, SignerMissing: {} })
export type OutMessage = typeof OutMessage.Type

// COMMAND

const day = 86_400
const Title = Text(200)
const Description = Text(5000)

/** Publishes the request, open from when it is signed for `days`. */
export const PublishRequest = Command.define('PublishRequest', {
  args: { title: Title, description: Description, days: DayChoice },
  messages: [Message.SucceededPublishRequest, Message.FailedPublishRequest],
  execute: ({ title, description, days }) =>
    publishEvent((kit, createdAt) =>
      kit.requestTemplate({ title, description, expiresAt: createdAt + Number(days) * day }, createdAt),
    ).pipe(
      Effect.map((event) => Message.SucceededPublishRequest({ job: event.id })),
      Effect.catch((error) => Effect.succeed(Message.FailedPublishRequest({ failure: publishFailureOf(error) }))),
    ),
})

// INIT

export const init = (language: Language, me: Me): Model => ({
  language,
  me,
  title: '',
  description: '',
  days: '7',
  status: FormStatus.Editing(),
  maybeFailure: Option.none(),
})

// UPDATE

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage, Signers | SidequestClient>

const submit = (model: Model): UpdateReturn => {
  if (!Me.guards.Ready(model.me)) {
    return { model, outMessage: OutMessage.SignerMissing() }
  }
  const title = Schema.decodeUnknownOption(Title)(model.title.trim())
  const description = Schema.decodeUnknownOption(Description)(model.description.trim())
  if (Option.isNone(title) || Option.isNone(description)) {
    return { model: modifyFields(model, { status: () => FormStatus.Invalid() }) }
  }
  return {
    model: modifyFields(model, { status: () => FormStatus.Submitting(), maybeFailure: () => Option.none() }),
    commands: [PublishRequest({ title: title.value, description: description.value, days: model.days })],
  }
}

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    UpdatedTitle: ({ value }) => ({ model: modifyFields(model, { title: () => value, status: editedStatus }) }),
    UpdatedDescription: ({ value }) => ({
      model: modifyFields(model, { description: () => value, status: editedStatus }),
    }),
    SelectedDays: ({ value }) =>
      Option.match(dayChoiceOf(value), {
        onNone: () => ({ model }),
        onSome: (days) => ({ model: modifyFields(model, { days: () => days, status: editedStatus }) }),
      }),
    SubmittedRequest: () => (FormStatus.guards.Submitting(model.status) ? { model } : submit(model)),
    SucceededPublishRequest: ({ job }) => ({
      model: init(model.language, model.me),
      outMessage: OutMessage.Posted({ job }),
    }),
    FailedPublishRequest: ({ failure }) => ({
      model: modifyFields(model, { status: () => FormStatus.Editing(), maybeFailure: () => Option.some(failure) }),
    }),
  })

// VIEW

const requestForm = (h: Html.HtmlBuilder<Message>, model: Model) => {
  const language = model.language
  return h.form(
    [h.OnSubmit(Message.SubmittedRequest()), h.Novalidate(true), ...styled(h, s.form())],
    [
      Ui.textField(h, {
        id: 'request-title',
        label: say(language, 'request.titleLabel'),
        hint: say(language, 'request.titleHint'),
        value: model.title,
        onInput: (value) => Message.UpdatedTitle({ value }),
        error: shown(model.status, textError(model.title, 200, language)),
        required: true,
      }),
      Ui.textArea(h, {
        id: 'request-description',
        label: say(language, 'request.descriptionLabel'),
        hint: say(language, 'request.descriptionHint'),
        value: model.description,
        onInput: (value) => Message.UpdatedDescription({ value }),
        error: shown(model.status, textError(model.description, 5000, language)),
        required: true,
      }),
      Ui.selectField(h, {
        id: 'request-days',
        label: say(language, 'request.openFor'),
        hint: say(language, 'request.openForHint'),
        value: model.days,
        options: dayChoices.map((days) => ({
          value: days,
          label: format(language, 'form.days', { count: Number(days) }),
        })),
        onChange: (value) => Message.SelectedDays({ value }),
      }),
      Option.match(model.maybeFailure, {
        onNone: () => h.empty,
        onSome: (failure) => publishFailureNotice(h, language, failure, identityHref(AppRoute.NewRequest())),
      }),
      h.div(styled(h, s.actions()), [
        Ui.submit(h, {
          label: FormStatus.guards.Submitting(model.status)
            ? say(language, 'request.posting')
            : say(language, 'request.post'),
          busy: FormStatus.guards.Submitting(model.status),
        }),
      ]),
    ],
  )
}

export const view = Submodel.defineView<Model, Message>((model, h) => {
  const { language, me } = model
  return h.div(styled(h, s.page()), [
    Ui.pageHead(h, say(language, 'request.title'), [say(language, 'request.lede')]),
    signerOnly(h, { language, me, route: AppRoute.NewRequest() }, () =>
      h.section(styled(h, s.panel()), [requestForm(h, model)]),
    ),
  ])
})
