import { format } from '@sidequest/i18n'
import { Option, Schema } from 'effect'
import { type Html, Submodel, type Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'
import { editedStatus, FormStatus, shown, textError } from '../../Forms.ts'
import { Language } from '../../Language.ts'
import { styled } from '../../Styled.ts'
import { say } from '../../Text.ts'
import * as Ui from '../../Ui.ts'
import * as s from '../../Ui.styles.ts'

// One side's review of the other once the job settled: a rating from 1 to 5 and a text, checked here as the
// vocabulary's review takes them. The job page signs and publishes it; the fold counts the latest review of each side.

// MODEL

const Rating = Schema.Literals(['1', '2', '3', '4', '5'])
const ratings: ReadonlyArray<typeof Rating.Type> = ['5', '4', '3', '2', '1']

export const Model = Schema.Struct({
  language: Language,
  rating: Rating,
  text: Schema.String,
  status: FormStatus,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  SelectedRating: { value: Schema.String },
  UpdatedText: { value: Schema.String },
  SubmittedReview: {},
})
export type Message = typeof Message.Type

/** The review passed its checks: the job page signs and publishes it. */
export const OutMessage = defineMessageUnion({ Submitted: { rating: Schema.Int, text: Schema.String } })
export type OutMessage = typeof OutMessage.Type

// INIT

export const init = (language: Language): Model => ({
  language,
  rating: '5',
  text: '',
  status: FormStatus.Editing(),
})

/** The job page is done with the submission, published or not: the form can be sent again. */
export const settled = (model: Model): Model => modifyFields(model, { status: () => FormStatus.Editing() })

// UPDATE

const longestText = 2000

export const update = (model: Model, message: Message): Update.ReturnWithOutMessage<Model, Message, OutMessage> =>
  Message.match<Update.ReturnWithOutMessage<Model, Message, OutMessage>>(message, {
    SelectedRating: ({ value }) =>
      Option.match(Schema.decodeUnknownOption(Rating)(value), {
        onNone: () => ({ model }),
        onSome: (rating) => ({ model: modifyFields(model, { rating: () => rating }) }),
      }),
    UpdatedText: ({ value }) => ({ model: modifyFields(model, { text: () => value, status: editedStatus }) }),
    SubmittedReview: () => {
      if (FormStatus.guards.Submitting(model.status)) {
        return { model }
      }
      return Option.isSome(textError(model.text, longestText, model.language))
        ? { model: modifyFields(model, { status: () => FormStatus.Invalid() }) }
        : {
            model: modifyFields(model, { status: () => FormStatus.Submitting() }),
            outMessage: OutMessage.Submitted({ rating: Number(model.rating), text: model.text.trim() }),
          }
    },
  })

// VIEW

export const view = Submodel.defineView<Model, Message>((model, h: Html.HtmlBuilder<Message>) => {
  const language = model.language
  return h.form(
    [h.OnSubmit(Message.SubmittedReview()), h.Novalidate(true), ...styled(h, s.form())],
    [
      Ui.selectField(h, {
        id: 'review-rating',
        label: say(language, 'review.rating'),
        value: model.rating,
        options: ratings.map((rating) => ({
          value: rating,
          label: format(language, 'review.stars', { count: Number(rating) }),
        })),
        onChange: (value) => Message.SelectedRating({ value }),
      }),
      Ui.textArea(h, {
        id: 'review-text',
        label: say(language, 'review.text'),
        value: model.text,
        onInput: (value) => Message.UpdatedText({ value }),
        error: shown(model.status, textError(model.text, longestText, language)),
        required: true,
      }),
      h.div(styled(h, s.actions()), [
        Ui.submit(h, { label: say(language, 'review.submit'), busy: FormStatus.guards.Submitting(model.status) }),
      ]),
    ],
  )
})
