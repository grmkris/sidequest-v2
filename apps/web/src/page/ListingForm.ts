import { format } from '@sidequest/i18n'
import { type Listing, ListingDetails, UsdcOnArcTestnet } from '@sidequest/protocol'
import { Array, Option, Schema } from 'effect'
import { type Html, Submodel, type Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'
import { editableUnits, formatUnits, parseUnits } from '../Amount.ts'
import { editedStatus, FormStatus, formProblem, shown, textError } from '../Forms.ts'
import { Language } from '../Language.ts'
import type { Problem } from '../Problem.ts'
import { styled } from '../Styled.ts'
import { say } from '../Text.ts'
import * as Ui from '../Ui.ts'
import * as s from '../Ui.styles.ts'

// The fields of a listing, shared by publishing a new one and editing your own: checked here, sent by the page.

// MODEL

export const Model = Schema.Struct({
  language: Language,
  title: Schema.String,
  description: Schema.String,
  tags: Schema.String,
  price: Schema.String,
  status: FormStatus,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  UpdatedTitle: { value: Schema.String },
  UpdatedDescription: { value: Schema.String },
  UpdatedTags: { value: Schema.String },
  UpdatedPrice: { value: Schema.String },
  SubmittedListing: {},
})
export type Message = typeof Message.Type

/** The fields passed their checks: the page sends them. */
export const OutMessage = defineMessageUnion({ Submitted: { details: ListingDetails } })
export type OutMessage = typeof OutMessage.Type

// INIT

export const init = (language: Language): Model => ({
  language,
  title: '',
  description: '',
  tags: '',
  price: '',
  status: FormStatus.Editing(),
})

/** The form filled in with a listing, to edit it. */
export const fromListing = (language: Language, listing: Listing): Model => ({
  language,
  title: listing.title,
  description: listing.description,
  tags: listing.tags.join(', '),
  price: Option.match(Option.fromNullishOr(listing.priceHint), {
    onNone: () => '',
    onSome: (hint) => editableUnits(hint.amount, UsdcOnArcTestnet.decimals, language),
  }),
  status: FormStatus.Editing(),
})

/** The server refused what the page sent. */
export const refused = (model: Model, problem: Problem): Model =>
  modifyFields(model, { status: () => FormStatus.Failed({ problem }) })

// CHECKS

const tagsOf = (text: string): ReadonlyArray<string> =>
  Array.dedupe(
    Array.filter(
      Array.map(text.split(','), (tag) => tag.trim()),
      (tag) => tag.length > 0,
    ),
  )

const tagsError = (text: string, language: Language): Option.Option<string> => {
  const tags = tagsOf(text)
  if (tags.length > 10) {
    return Option.some(say(language, 'listingForm.tooManyTags'))
  }
  return Array.some(tags, (tag) => tag.length > 40)
    ? Option.some(format(language, 'listingForm.tagTooLong', { max: 40 }))
    : Option.none()
}

const priceOf = (model: Model) =>
  model.price.trim().length === 0
    ? Option.some(Option.none())
    : Option.map(
        Option.filter(parseUnits(model.price, UsdcOnArcTestnet.decimals, model.language), (amount) => amount !== '0'),
        (amount) => Option.some({ amount, asset: UsdcOnArcTestnet.id }),
      )

const priceError = (model: Model): Option.Option<string> =>
  Option.isSome(priceOf(model))
    ? Option.none()
    : Option.some(
        format(model.language, 'form.amount', {
          example: formatUnits('250500000', UsdcOnArcTestnet.decimals, model.language),
          decimals: UsdcOnArcTestnet.decimals,
        }),
      )

/** The listing the fields describe, if every one of them passes. */
const detailsOf = (model: Model): Option.Option<ListingDetails> =>
  Option.flatMap(priceOf(model), (maybePrice) =>
    Schema.decodeUnknownOption(ListingDetails)({
      title: model.title.trim(),
      description: model.description.trim(),
      tags: tagsOf(model.tags),
      ...Option.match(maybePrice, { onNone: () => ({}), onSome: (priceHint) => ({ priceHint }) }),
    }),
  )

// UPDATE

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage>

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    UpdatedTitle: ({ value }) => ({ model: modifyFields(model, { title: () => value, status: editedStatus }) }),
    UpdatedDescription: ({ value }) => ({
      model: modifyFields(model, { description: () => value, status: editedStatus }),
    }),
    UpdatedTags: ({ value }) => ({ model: modifyFields(model, { tags: () => value, status: editedStatus }) }),
    UpdatedPrice: ({ value }) => ({ model: modifyFields(model, { price: () => value, status: editedStatus }) }),
    SubmittedListing: () => {
      if (FormStatus.guards.Submitting(model.status)) {
        return { model }
      }
      return Option.match(detailsOf(model), {
        onNone: () => ({ model: modifyFields(model, { status: () => FormStatus.Invalid() }) }),
        onSome: (details) => ({
          model: modifyFields(model, { status: () => FormStatus.Submitting() }),
          outMessage: OutMessage.Submitted({ details }),
        }),
      })
    },
  })

// VIEW

type ViewInputs = { readonly submitLabel: string; readonly submittingLabel: string }

const fields = (h: Html.HtmlBuilder<Message>, model: Model) => {
  const language = model.language
  return [
    Ui.textField(h, {
      id: 'listing-title',
      label: say(language, 'listingForm.titleLabel'),
      hint: say(language, 'listingForm.titleHint'),
      value: model.title,
      onInput: (value) => Message.UpdatedTitle({ value }),
      error: shown(model.status, textError(model.title, 200, language)),
      required: true,
    }),
    Ui.textArea(h, {
      id: 'listing-description',
      label: say(language, 'listingForm.descriptionLabel'),
      value: model.description,
      onInput: (value) => Message.UpdatedDescription({ value }),
      error: shown(model.status, textError(model.description, 5000, language)),
      required: true,
    }),
    Ui.textField(h, {
      id: 'listing-tags',
      label: say(language, 'listingForm.tagsLabel'),
      hint: say(language, 'listingForm.tagsHint'),
      value: model.tags,
      onInput: (value) => Message.UpdatedTags({ value }),
      error: shown(model.status, tagsError(model.tags, language)),
    }),
    Ui.textField(h, {
      id: 'listing-price',
      label: say(language, 'listingForm.priceLabel'),
      hint: say(language, 'listingForm.priceHint'),
      value: model.price,
      inputMode: 'decimal',
      onInput: (value) => Message.UpdatedPrice({ value }),
      error: shown(model.status, priceError(model)),
    }),
  ]
}

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, { submitLabel, submittingLabel }, h) =>
  h.form(
    [h.OnSubmit(Message.SubmittedListing()), h.Novalidate(true), ...styled(h, s.form())],
    [
      ...fields(h, model),
      Ui.maybeProblem(h, model.language, formProblem(model.status)),
      h.div(styled(h, s.actions()), [
        Ui.submit(h, {
          label: FormStatus.guards.Submitting(model.status) ? submittingLabel : submitLabel,
          busy: FormStatus.guards.Submitting(model.status),
        }),
      ]),
    ],
  ),
)
