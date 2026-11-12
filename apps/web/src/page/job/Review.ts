import { format } from '@sidequest/i18n'
import { JobId, Review as ReviewRecord } from '@sidequest/protocol'
import { Effect, Option, Schema } from 'effect'
import { Command, type Html, Submodel, type Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'
import { SidequestClient } from '../../Api.ts'
import { Language } from '../../Language.ts'
import { Problem, problemOf } from '../../Problem.ts'
import { styled } from '../../Styled.ts'
import { say } from '../../Text.ts'
import * as Ui from '../../Ui.ts'
import * as s from '../../Ui.styles.ts'

// After settlement, each side reviews the other once: a rating from 1 to 5 and an optional comment.

// MODEL

const Rating = ReviewRecord.fields.rating

const ReviewStatus = defineTaggedUnion({
  Editing: {},
  Invalid: {},
  Sending: {},
  Sent: {},
  Failed: { problem: Problem },
})
type ReviewStatus = typeof ReviewStatus.Type

export const Model = Schema.Struct({
  language: Language,
  job: JobId,
  maybeRating: Schema.Option(Rating),
  comment: Schema.String,
  status: ReviewStatus,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  SelectedRating: { value: Schema.String },
  UpdatedComment: { value: Schema.String },
  SubmittedReview: {},
  SucceededLeaveReview: {},
  FailedLeaveReview: { problem: Problem },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({ Reviewed: {} })
export type OutMessage = typeof OutMessage.Type

// COMMAND

export const LeaveReview = Command.define('LeaveReview', {
  args: { job: JobId, rating: Rating, maybeComment: Schema.Option(ReviewRecord.fields.comment) },
  messages: [Message.SucceededLeaveReview, Message.FailedLeaveReview],
  execute: ({ job, rating, maybeComment }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      yield* api.jobs.review({
        params: { job },
        payload: Option.match(maybeComment, { onNone: () => ({ rating }), onSome: (comment) => ({ rating, comment }) }),
      })
      return Message.SucceededLeaveReview()
    }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedLeaveReview({ problem: problemOf(error) })))),
})

// INIT

export const init = (language: Language, job: JobId): Model => ({
  language,
  job,
  maybeRating: Option.none(),
  comment: '',
  status: ReviewStatus.Editing(),
})

// UPDATE

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage, SidequestClient>

const submit = (model: Model): UpdateReturn => {
  const comment = model.comment.trim()
  const maybeComment =
    comment.length === 0
      ? Option.some(Option.none())
      : Option.map(Schema.decodeUnknownOption(ReviewRecord.fields.comment)(comment), Option.some)
  if (Option.isNone(model.maybeRating) || Option.isNone(maybeComment)) {
    return { model: modifyFields(model, { status: () => ReviewStatus.Invalid() }) }
  }
  return {
    model: modifyFields(model, { status: () => ReviewStatus.Sending() }),
    commands: [LeaveReview({ job: model.job, rating: model.maybeRating.value, maybeComment: maybeComment.value })],
  }
}

const isAlreadyReviewed = (problem: Problem) => Problem.guards.Conflict(problem) && problem.reason === 'AlreadyReviewed'

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    SelectedRating: ({ value }) => ({
      model: modifyFields(model, {
        maybeRating: (rating) => Option.orElse(Schema.decodeUnknownOption(Rating)(Number(value)), () => rating),
        status: () => ReviewStatus.Editing(),
      }),
    }),
    UpdatedComment: ({ value }) => ({ model: modifyFields(model, { comment: () => value }) }),
    SubmittedReview: () => (ReviewStatus.guards.Sending(model.status) ? { model } : submit(model)),
    SucceededLeaveReview: () => ({
      model: modifyFields(model, { status: () => ReviewStatus.Sent() }),
      outMessage: OutMessage.Reviewed(),
    }),
    FailedLeaveReview: ({ problem }) => ({
      model: modifyFields(model, {
        status: () => (isAlreadyReviewed(problem) ? ReviewStatus.Sent() : ReviewStatus.Failed({ problem })),
      }),
    }),
  })

// VIEW

const ratings: ReadonlyArray<string> = ['1', '2', '3', '4', '5']

const ratingChoice = (h: Html.HtmlBuilder<Message>, model: Model, value: string) =>
  h.keyed('label')(value, styled(h, s.choice()), [
    h.input([
      h.Type('radio'),
      h.Name('rating'),
      h.Value(value),
      h.Checked(Option.contains(model.maybeRating, Number(value))),
      h.OnChange(() => Message.SelectedRating({ value })),
    ]),
    format(model.language, 'review.stars', { count: Number(value) }),
  ])

const reviewForm = (h: Html.HtmlBuilder<Message>, model: Model) =>
  h.form(
    [h.OnSubmit(Message.SubmittedReview()), h.Novalidate(true), ...styled(h, s.form())],
    [
      h.fieldset(styled(h, s.choices()), [
        h.legend(styled(h, s.legend()), [say(model.language, 'review.rating')]),
        ...ratings.map((value) => ratingChoice(h, model, value)),
      ]),
      ReviewStatus.guards.Invalid(model.status)
        ? h.p(styled(h, s.fieldError()), [say(model.language, 'review.invalid')])
        : h.empty,
      Ui.textArea(h, {
        id: 'review-comment',
        label: say(model.language, 'review.comment'),
        value: model.comment,
        onInput: (value) => Message.UpdatedComment({ value }),
      }),
      ReviewStatus.guards.Failed(model.status) ? Ui.problemNotice(h, model.language, model.status.problem) : h.empty,
      h.div(styled(h, s.actions()), [
        Ui.submit(h, { label: say(model.language, 'review.submit'), busy: ReviewStatus.guards.Sending(model.status) }),
      ]),
    ],
  )

export const view = Submodel.defineView<Model, Message>((model, h) =>
  h.section(
    [h.AriaLabelledBy('job-review'), ...styled(h, s.panel())],
    [
      h.h2([h.Id('job-review')], [say(model.language, 'review.title')]),
      ReviewStatus.guards.Sent(model.status)
        ? Ui.notice(h, 'done', [h.p([], [say(model.language, 'review.sent')])])
        : reviewForm(h, model),
    ],
  ),
)
