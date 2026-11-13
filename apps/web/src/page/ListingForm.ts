import { format } from '@sidequest/i18n'
import { type IndexListingDetail, PriceHint, Text, UsdcOnArcTestnet } from '@sidequest/protocol'
import { Array, Option, Schema } from 'effect'
import { type Html, Submodel, type Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'
import { editableUnits, formatUnits, parseUnits } from '../Amount.ts'
import { editedStatus, FormStatus, shown, textError } from '../Forms.ts'
import { Language } from '../Language.ts'
import { styled } from '../Styled.ts'
import { say } from '../Text.ts'
import * as Ui from '../Ui.ts'
import * as s from '../Ui.styles.ts'

// The fields of a NIP-99 listing, shared by publishing a new one and publishing a new version of your own: checked
// here, signed and sent by the page.

// MODEL

/** What a seller writes about a listing: everything but its slug, status and first publication, which the page keeps. The
 * price is a hint; topics are lowercase, as `#t` filters match them. */
export const ListingDraft = Schema.Struct({
  title: Text(200),
  summary: Text(500),
  description: Text(5000),
  topics: Schema.Array(Text(40).check(Schema.isLowercased())).check(Schema.isMaxLength(10), Schema.isUnique()),
  price: Schema.optionalKey(PriceHint),
})
export type ListingDraft = typeof ListingDraft.Type

export const Model = Schema.Struct({
  language: Language,
  title: Schema.String,
  summary: Schema.String,
  description: Schema.String,
  topics: Schema.String,
  price: Schema.String,
  status: FormStatus,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  UpdatedTitle: { value: Schema.String },
  UpdatedSummary: { value: Schema.String },
  UpdatedDescription: { value: Schema.String },
  UpdatedTopics: { value: Schema.String },
  UpdatedPrice: { value: Schema.String },
  SubmittedListing: {},
})
export type Message = typeof Message.Type

/** The fields passed their checks: the page signs and publishes them. */
export const OutMessage = defineMessageUnion({ Submitted: { draft: ListingDraft } })
export type OutMessage = typeof OutMessage.Type

// INIT

export const init = (language: Language): Model => ({
  language,
  title: '',
  summary: '',
  description: '',
  topics: '',
  price: '',
  status: FormStatus.Editing(),
})

/** The form filled in with a listing, for its next version. */
export const fromListing = (language: Language, listing: IndexListingDetail): Model => ({
  language,
  title: listing.title,
  summary: listing.summary,
  description: listing.description,
  topics: listing.topics.join(', '),
  price: Option.match(Option.fromNullishOr(listing.price), {
    onNone: () => '',
    onSome: (hint) => editableUnits(hint.amount, UsdcOnArcTestnet.decimals, language),
  }),
  status: FormStatus.Editing(),
})

/** The page is done with the submission, published or not: the form can be sent again. */
export const settled = (model: Model): Model => modifyFields(model, { status: () => FormStatus.Editing() })

// CHECKS

const topicsOf = (text: string): ReadonlyArray<string> =>
  Array.dedupe(
    Array.filter(
      Array.map(text.split(','), (topic) => topic.trim().toLowerCase()),
      (topic) => topic.length > 0,
    ),
  )

const topicsError = (text: string, language: Language): Option.Option<string> => {
  const topics = topicsOf(text)
  if (topics.length > 10) {
    return Option.some(say(language, 'listingForm.tooManyTags'))
  }
  return Array.some(topics, (topic) => topic.length > 40)
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
const draftOf = (model: Model): Option.Option<ListingDraft> =>
  Option.flatMap(priceOf(model), (maybePrice) =>
    Schema.decodeUnknownOption(ListingDraft)({
      title: model.title.trim(),
      summary: model.summary.trim(),
      description: model.description.trim(),
      topics: topicsOf(model.topics),
      ...Option.match(maybePrice, { onNone: () => ({}), onSome: (price) => ({ price }) }),
    }),
  )

// UPDATE

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage>

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    UpdatedTitle: ({ value }) => ({ model: modifyFields(model, { title: () => value, status: editedStatus }) }),
    UpdatedSummary: ({ value }) => ({ model: modifyFields(model, { summary: () => value, status: editedStatus }) }),
    UpdatedDescription: ({ value }) => ({
      model: modifyFields(model, { description: () => value, status: editedStatus }),
    }),
    UpdatedTopics: ({ value }) => ({ model: modifyFields(model, { topics: () => value, status: editedStatus }) }),
    UpdatedPrice: ({ value }) => ({ model: modifyFields(model, { price: () => value, status: editedStatus }) }),
    SubmittedListing: () => {
      if (FormStatus.guards.Submitting(model.status)) {
        return { model }
      }
      return Option.match(draftOf(model), {
        onNone: () => ({ model: modifyFields(model, { status: () => FormStatus.Invalid() }) }),
        onSome: (draft) => ({
          model: modifyFields(model, { status: () => FormStatus.Submitting() }),
          outMessage: OutMessage.Submitted({ draft }),
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
    Ui.textField(h, {
      id: 'listing-summary',
      label: say(language, 'listingForm.summaryLabel'),
      hint: say(language, 'listingForm.summaryHint'),
      value: model.summary,
      onInput: (value) => Message.UpdatedSummary({ value }),
      error: shown(model.status, textError(model.summary, 500, language)),
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
      value: model.topics,
      onInput: (value) => Message.UpdatedTopics({ value }),
      error: shown(model.status, topicsError(model.topics, language)),
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
      h.div(styled(h, s.actions()), [
        Ui.submit(h, {
          label: FormStatus.guards.Submitting(model.status) ? submittingLabel : submitLabel,
          busy: FormStatus.guards.Submitting(model.status),
        }),
      ]),
    ],
  ),
)
