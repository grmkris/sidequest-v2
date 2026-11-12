import { format } from '@sidequest/i18n'
import { JobId, WorkRequest } from '@sidequest/protocol'
import { Clock, Effect, Option, Schema } from 'effect'
import { Command, type Html, Submodel, type Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'
import { SidequestClient } from '../Api.ts'
import {
  DayChoice,
  dayChoiceOf,
  dayChoices,
  editedStatus,
  FormStatus,
  formProblem,
  shown,
  textError,
} from '../Forms.ts'
import { signedInOnly } from '../Gate.ts'
import { Language } from '../Language.ts'
import { Problem, problemOf } from '../Problem.ts'
import { AppRoute } from '../route.ts'
import type { Session } from '../Session.ts'
import { styled } from '../Styled.ts'
import { say } from '../Text.ts'
import * as Ui from '../Ui.ts'
import * as s from '../Ui.styles.ts'

// A buyer posts a work request: what they need, and how long it stays open for proposals.

// MODEL

export const Model = Schema.Struct({
  language: Language,
  title: Schema.String,
  description: Schema.String,
  days: DayChoice,
  status: FormStatus,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  UpdatedTitle: { value: Schema.String },
  UpdatedDescription: { value: Schema.String },
  SelectedDays: { value: Schema.String },
  SubmittedRequest: {},
  SucceededPostRequest: { job: JobId },
  FailedPostRequest: { problem: Problem },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({ Posted: { job: JobId } })
export type OutMessage = typeof OutMessage.Type

// COMMAND

const day = 86_400

/** Posts the request, open from now for `days`: the clock is read when the request is sent. */
export const PostRequest = Command.define('PostRequest', {
  args: { title: WorkRequest.fields.title, description: WorkRequest.fields.description, days: DayChoice },
  messages: [Message.SucceededPostRequest, Message.FailedPostRequest],
  execute: ({ title, description, days }) =>
    Effect.gen(function* () {
      const now = Math.floor((yield* Clock.currentTimeMillis) / 1000)
      const api = yield* (yield* SidequestClient).api
      const { id } = yield* api.jobs.post({ payload: { title, description, expiresAt: now + Number(days) * day } })
      return Message.SucceededPostRequest({ job: id })
    }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedPostRequest({ problem: problemOf(error) })))),
})

// INIT

export const init = (language: Language): Model => ({
  language,
  title: '',
  description: '',
  days: '7',
  status: FormStatus.Editing(),
})

// UPDATE

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage, SidequestClient>

const submit = (model: Model): UpdateReturn => {
  const title = Schema.decodeUnknownOption(WorkRequest.fields.title)(model.title.trim())
  const description = Schema.decodeUnknownOption(WorkRequest.fields.description)(model.description.trim())
  if (Option.isNone(title) || Option.isNone(description)) {
    return { model: modifyFields(model, { status: () => FormStatus.Invalid() }) }
  }
  return {
    model: modifyFields(model, { status: () => FormStatus.Submitting() }),
    commands: [PostRequest({ title: title.value, description: description.value, days: model.days })],
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
    SucceededPostRequest: ({ job }) => ({
      model: init(model.language),
      outMessage: OutMessage.Posted({ job }),
    }),
    FailedPostRequest: ({ problem }) => ({
      model: modifyFields(model, { status: () => FormStatus.Failed({ problem }) }),
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
      Ui.maybeProblem(h, language, formProblem(model.status)),
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

export const view = Submodel.defineView<Model, Message, { readonly session: Session }>((model, { session }, h) =>
  h.div(styled(h, s.page()), [
    Ui.pageHead(h, say(model.language, 'request.title'), [say(model.language, 'request.lede')]),
    signedInOnly(h, { language: model.language, session, route: AppRoute.NewRequest() }, () =>
      h.section(styled(h, s.panel()), [requestForm(h, model)]),
    ),
  ]),
)
