import { format } from '@sidequest/i18n'
import { AccountId, Listing, ListingDetails, ListingId } from '@sidequest/protocol'
import { Array, Effect, Option, Schema } from 'effect'
import { AsyncData, Command, type Html, Submodel, Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'
import { formatAmount } from '../Amount.ts'
import { SidequestClient } from '../Api.ts'
import { Language } from '../Language.ts'
import { defineReadNames, Names, nameOf, unnamed, withNames } from '../Names.ts'
import type { Preload } from '../Preload.ts'
import { Problem, problemOf } from '../Problem.ts'
import { styled } from '../Styled.ts'
import { say } from '../Text.ts'
import * as Ui from '../Ui.ts'
import * as s from '../Ui.styles.ts'
import * as ListingForm from './ListingForm.ts'

// One listing, which anyone may read. Its owner edits or withdraws it here.

// MODEL

const ListingData = AsyncData.Schema(Listing, Problem)

/** What the owner is doing: reading it, editing it, or withdrawing it. */
const Mode = defineTaggedUnion({
  Viewing: { maybeProblem: Schema.Option(Problem) },
  Editing: { form: ListingForm.Model },
  Withdrawing: {},
})
type Mode = typeof Mode.Type

export const Model = Schema.Struct({
  language: Language,
  id: ListingId,
  listing: ListingData.schema,
  mode: Mode,
  names: Names,
  askedNames: Schema.Array(AccountId),
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  SucceededReadListing: { listing: Listing },
  FailedReadListing: { problem: Problem },
  ClickedEdit: {},
  ClickedCancelEdit: {},
  GotListingFormMessage: { message: ListingForm.Message },
  SucceededUpdateListing: {},
  FailedUpdateListing: { problem: Problem },
  ClickedWithdraw: {},
  SucceededWithdrawListing: {},
  FailedWithdrawListing: { problem: Problem },
  SucceededReadNames: { names: Names },
  FailedReadNames: { problem: Problem },
})
export type Message = typeof Message.Type

// COMMAND

export const ReadNames = defineReadNames(Message.SucceededReadNames, Message.FailedReadNames)

export const ReadListing = Command.define('ReadListing', {
  args: { id: ListingId },
  messages: [Message.SucceededReadListing, Message.FailedReadListing],
  execute: ({ id }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      const listing = yield* api.listings.get({ params: { listing: id } })
      return Message.SucceededReadListing({ listing })
    }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedReadListing({ problem: problemOf(error) })))),
})

export const UpdateListing = Command.define('UpdateListing', {
  args: { id: ListingId, details: ListingDetails },
  messages: [Message.SucceededUpdateListing, Message.FailedUpdateListing],
  execute: ({ id, details }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      yield* api.listings.update({ params: { listing: id }, payload: details })
      return Message.SucceededUpdateListing()
    }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedUpdateListing({ problem: problemOf(error) })))),
})

export const WithdrawListing = Command.define('WithdrawListing', {
  args: { id: ListingId },
  messages: [Message.SucceededWithdrawListing, Message.FailedWithdrawListing],
  execute: ({ id }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      yield* api.listings.withdraw({ params: { listing: id } })
      return Message.SucceededWithdrawListing()
    }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedWithdrawListing({ problem: problemOf(error) })))),
})

// INIT

type UpdateReturn = Update.Return<Model, Message, SidequestClient>

type ListingPreload = Extract<Preload, { readonly _tag: 'Listing' }>

export const init = (language: Language, id: ListingId, maybePreload: Option.Option<ListingPreload>): UpdateReturn => {
  const viewing = Mode.Viewing({ maybeProblem: Option.none() })
  return Option.match(
    Option.filter(maybePreload, (preload) => preload.listing.id === id),
    {
      onSome: ({ listing, names }) => ({
        model: {
          language,
          id,
          listing: ListingData.Success({ data: listing }),
          mode: viewing,
          names,
          askedNames: [listing.owner],
        },
      }),
      onNone: () => ({
        model: { language, id, listing: AsyncData.Loading(), mode: viewing, names: [], askedNames: [] },
        commands: [ReadListing({ id })],
      }),
    },
  )
}

// UPDATE

const viewing = (maybeProblem: Option.Option<Problem>) => Mode.Viewing({ maybeProblem })

const foldForm = Update.foldChild({
  update: ListingForm.update,
  read: (model: Model) => (Mode.guards.Editing(model.mode) ? Option.some(model.mode.form) : Option.none()),
  write: (model: Model, nextForm: ListingForm.Model): Model =>
    modifyFields(model, { mode: () => Mode.Editing({ form: nextForm }) }),
  toParentMessage: (message) => Message.GotListingFormMessage({ message }),
  foldOutMessage: ListingForm.OutMessage.match<Update.Step<Model, Message, SidequestClient>>({
    Submitted:
      ({ details }) =>
      (model) => ({ model, commands: [UpdateListing({ id: model.id, details })] }),
  }),
})

const reread = (model: Model, mode: Mode): UpdateReturn => ({
  model: modifyFields(model, {
    mode: () => mode,
    listing: (listing) => Option.getOrElse(AsyncData.revalidate(listing), () => listing),
  }),
  commands: [ReadListing({ id: model.id })],
})

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    SucceededReadListing: ({ listing }) => {
      const nextModel = modifyFields(model, { listing: () => ListingData.Success({ data: listing }) })
      return Array.match(unnamed([listing.owner], model.names, model.askedNames), {
        onEmpty: () => ({ model: nextModel }),
        onNonEmpty: (ids) => ({
          model: modifyFields(nextModel, { askedNames: Array.appendAll(ids) }),
          commands: [ReadNames({ ids })],
        }),
      })
    },
    FailedReadListing: ({ problem }) => ({
      model: modifyFields(model, { listing: () => ListingData.Failure({ error: problem }) }),
    }),
    ClickedEdit: () =>
      Option.match(AsyncData.getData(model.listing), {
        onNone: () => ({ model }),
        onSome: (listing) => ({
          model: modifyFields(model, {
            mode: () => Mode.Editing({ form: ListingForm.fromListing(model.language, listing) }),
          }),
        }),
      }),
    ClickedCancelEdit: () => ({ model: modifyFields(model, { mode: () => viewing(Option.none()) }) }),
    GotListingFormMessage: ({ message: formMessage }) => foldForm(model, formMessage),
    SucceededUpdateListing: () => reread(model, viewing(Option.none())),
    FailedUpdateListing: ({ problem }) => ({
      model: modifyFields(model, {
        mode: (mode) =>
          Mode.guards.Editing(mode) ? Mode.Editing({ form: ListingForm.refused(mode.form, problem) }) : mode,
      }),
    }),
    ClickedWithdraw: () => ({
      model: modifyFields(model, { mode: () => Mode.Withdrawing() }),
      commands: [WithdrawListing({ id: model.id })],
    }),
    SucceededWithdrawListing: () => reread(model, viewing(Option.none())),
    FailedWithdrawListing: ({ problem }) => ({
      model: modifyFields(model, { mode: () => viewing(Option.some(problem)) }),
    }),
    SucceededReadNames: ({ names }) => ({ model: modifyFields(model, { names: (known) => withNames(known, names) }) }),
    FailedReadNames: () => ({ model }),
  })

// VIEW

type ViewInputs = { readonly maybeAccount: Option.Option<AccountId> }

const details = (h: Html.HtmlBuilder<Message>, model: Model, listing: Listing) => {
  const language = model.language
  return h.section(styled(h, s.panel()), [
    h.p([], [listing.description]),
    Ui.facts(h, [
      Ui.fact(
        h,
        say(language, 'listingPage.price'),
        Option.match(Option.fromNullishOr(listing.priceHint), {
          onNone: () => say(language, 'listing.noPrice'),
          onSome: (hint) =>
            format(language, 'listing.priceFrom', { price: formatAmount(hint.amount, hint.asset, language) }),
        }),
      ),
      Ui.fact(
        h,
        say(language, 'listing.tags'),
        listing.tags.length === 0 ? say(language, 'listingPage.noTags') : listing.tags.join(', '),
      ),
      Ui.fact(h, say(language, 'listingPage.seller'), nameOf(model.names, listing.owner, language)),
      Ui.fact(
        h,
        say(language, 'listingPage.state'),
        listing.state === 'published'
          ? Ui.chip(h, say(language, 'listingPage.published'), 'done')
          : Ui.chip(h, say(language, 'listingPage.withdrawn')),
      ),
    ]),
  ])
}

const ownerActions = (h: Html.HtmlBuilder<Message>, model: Model, listing: Listing) =>
  Mode.match(model.mode, {
    Viewing: ({ maybeProblem }) =>
      h.div(styled(h, s.section()), [
        listing.state === 'published'
          ? h.div(styled(h, s.actions()), [
              Ui.button(h, {
                label: say(model.language, 'listingPage.edit'),
                onClick: Message.ClickedEdit(),
                kind: 'primary',
              }),
              Ui.button(h, {
                label: say(model.language, 'listingPage.withdraw'),
                onClick: Message.ClickedWithdraw(),
                kind: 'destructive',
              }),
            ])
          : h.p(styled(h, s.meta()), [say(model.language, 'listingPage.withdrawnNote')]),
        Ui.maybeProblem(h, model.language, maybeProblem),
      ]),
    Editing: ({ form }) =>
      h.section(
        [h.AriaLabel(say(model.language, 'listingPage.edit')), ...styled(h, s.panel())],
        [
          h.submodel({
            slotId: 'listing-form',
            model: form,
            view: ListingForm.view,
            viewInputs: {
              submitLabel: say(model.language, 'listingPage.save'),
              submittingLabel: say(model.language, 'listingPage.saving'),
            },
            toParentMessage: (message) => Message.GotListingFormMessage({ message }),
          }),
          h.div(styled(h, s.actions()), [
            Ui.button(h, { label: say(model.language, 'common.cancel'), onClick: Message.ClickedCancelEdit() }),
          ]),
        ],
      ),
    Withdrawing: () =>
      Ui.button(h, {
        label: say(model.language, 'listingPage.withdrawing'),
        onClick: Message.ClickedWithdraw(),
        busy: true,
      }),
  })

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, { maybeAccount }, h) =>
  AsyncData.matchData(model.listing, {
    onEmpty: () => h.div(styled(h, s.page()), [Ui.pageHead(h, say(model.language, 'listingPage.loading'))]),
    onFailure: (problem) =>
      h.div(styled(h, s.page()), [
        Ui.pageHead(h, say(model.language, 'listingPage.unavailable')),
        Ui.problemNotice(h, model.language, problem),
      ]),
    onData: (listing) =>
      h.div(styled(h, s.page()), [
        Ui.pageHead(h, listing.title),
        details(h, model, listing),
        Option.contains(maybeAccount, listing.owner) ? ownerActions(h, model, listing) : h.empty,
      ]),
  }),
)

/** The page's title, for the document. */
export const documentTitle = (model: Model): string =>
  Option.match(AsyncData.getData(model.listing), {
    onNone: () => say(model.language, 'listingPage.loading'),
    onSome: (listing) => listing.title,
  })
