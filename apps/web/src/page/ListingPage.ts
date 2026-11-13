import { IndexListingDetail, IndexListingSlug } from '@sidequest/protocol'
import { Effect, Option, Schema } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import { AsyncData, Command, type Html, Submodel, Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'
import { SidequestClient } from '../Api.ts'
import { Language } from '../Language.ts'
import { Me, pubkeyOf } from '../Me.ts'
import { shortNpub } from '../Names.ts'
import type { Preload } from '../Preload.ts'
import { failedWith, Problem } from '../Problem.ts'
import { PublishFailure, publishEvent, publishFailureNotice, publishFailureOf } from '../Publishing.ts'
import { AppRoute, identityHref } from '../route.ts'
import type { Signers } from '../Signer.ts'
import { styled } from '../Styled.ts'
import { say } from '../Text.ts'
import * as Ui from '../Ui.ts'
import * as s from '../Ui.styles.ts'
import { listingPriceText } from './Home.ts'
import { payPerCallSection } from './PayPerCallView.ts'
import * as ListingForm from './ListingForm.ts'

// One seller's listing as the index holds it: the latest NIP-99 event under their key and its slug, which anyone may
// read. Its seller edits it here by publishing a newer version under the same slug.

// MODEL

const ListingData = AsyncData.Schema(IndexListingDetail, Problem)

/** What the seller is doing: reading it, or writing its next version. */
export const Mode = defineTaggedUnion({
  Viewing: { maybeFailure: Schema.Option(PublishFailure) },
  Editing: { form: ListingForm.Model, maybeFailure: Schema.Option(PublishFailure) },
})
type Mode = typeof Mode.Type

export const Model = Schema.Struct({
  language: Language,
  pubkey: Schema.String,
  slug: IndexListingSlug,
  listing: ListingData.schema,
  mode: Mode,
  me: Me,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  SucceededReadListing: { listing: IndexListingDetail },
  FailedReadListing: { problem: Problem },
  ClickedEdit: {},
  ClickedCancelEdit: {},
  GotListingFormMessage: { message: ListingForm.Message },
  SucceededPublishVersion: {},
  FailedPublishVersion: { failure: PublishFailure },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({ SignerMissing: {} })
export type OutMessage = typeof OutMessage.Type

// COMMAND

/** The listing; `fresh` right after its seller published a version, past what the browser's cache kept. */
export const ReadListing = Command.define('ReadListing', {
  args: { pubkey: Schema.String, slug: IndexListingSlug, fresh: Schema.Boolean },
  messages: [Message.SucceededReadListing, Message.FailedReadListing],
  execute: ({ pubkey, slug, fresh }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      const listing = yield* api.events
        .listing({ params: { pubkey, slug } })
        .pipe(Effect.provideService(FetchHttpClient.RequestInit, fresh ? { cache: 'no-cache' } : {}))
      return Message.SucceededReadListing({ listing })
    }).pipe(Effect.catch(failedWith(Message.FailedReadListing))),
})

/**
 * The listing's next version: the draft, under the same slug, keeping its status, its first publication and, on a
 * pay-per-call listing, its resource and payTo (which the form does not edit).
 */
export const PublishVersion = Command.define('PublishVersion', {
  args: { listing: IndexListingDetail, draft: ListingForm.ListingDraft },
  messages: [Message.SucceededPublishVersion, Message.FailedPublishVersion],
  execute: ({ listing, draft }) =>
    publishEvent((kit, createdAt) =>
      kit.listingTemplate(
        {
          ...draft,
          slug: listing.slug,
          status: listing.status,
          publishedAt: listing.publishedAt,
          ...(listing.payPerCall === null
            ? {}
            : { x402: { resource: listing.payPerCall.resource, payTo: listing.payPerCall.payTo } }),
        },
        createdAt,
      ),
    ).pipe(
      Effect.as(Message.SucceededPublishVersion()),
      Effect.catch((error) => Effect.succeed(Message.FailedPublishVersion({ failure: publishFailureOf(error) }))),
    ),
})

// INIT

type Services = SidequestClient | Signers
type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage, Services>
type InitReturn = Update.Return<Model, Message, Services>

type ListingPreload = Extract<Preload, { readonly _tag: 'Listing' }>

const viewing = Mode.Viewing({ maybeFailure: Option.none() })

export const init = (
  language: Language,
  address: { readonly pubkey: string; readonly slug: typeof IndexListingSlug.Type },
  me: Me,
  maybePreload: Option.Option<ListingPreload>,
): InitReturn => {
  const base = { language, pubkey: address.pubkey, slug: address.slug, mode: viewing, me }
  return Option.match(
    Option.filter(maybePreload, ({ listing }) => listing.pubkey === address.pubkey && listing.slug === address.slug),
    {
      onSome: ({ listing }) => ({ model: { ...base, listing: ListingData.Success({ data: listing }) } }),
      onNone: () => ({
        model: { ...base, listing: AsyncData.Loading() },
        commands: [ReadListing({ pubkey: address.pubkey, slug: address.slug, fresh: false })],
      }),
    },
  )
}

// UPDATE

/** Whether the person is the listing's seller: their signer's key is the listing's. */
export const isSeller = (model: Model): boolean => Option.contains(pubkeyOf(model.me), model.pubkey)

const foldForm = Update.foldChild({
  update: ListingForm.update,
  read: (model: Model) => (Mode.guards.Editing(model.mode) ? Option.some(model.mode.form) : Option.none()),
  write: (model: Model, nextForm: ListingForm.Model): Model =>
    modifyFields(model, {
      mode: (mode) => (Mode.guards.Editing(mode) ? modifyFields(mode, { form: () => nextForm }) : mode),
    }),
  toParentMessage: (message) => Message.GotListingFormMessage({ message }),
  foldOutMessage: ListingForm.OutMessage.match<Update.StepWithOutMessage<Model, Message, OutMessage, Services>>({
    Submitted:
      ({ draft }) =>
      (model) =>
        Option.match(AsyncData.getData(model.listing), {
          onNone: () => ({ model }),
          onSome: (listing) =>
            Me.guards.Ready(model.me)
              ? { model, commands: [PublishVersion({ listing, draft })] }
              : {
                  model: modifyFields(model, { mode: () => viewing }),
                  outMessage: OutMessage.SignerMissing(),
                },
        }),
  }),
})

/** Read the listing again past the cache, keeping it on screen meanwhile. */
const reread = (model: Model, mode: Mode): UpdateReturn => ({
  model: modifyFields(model, {
    mode: () => mode,
    listing: (listing) => Option.getOrElse(AsyncData.revalidate(listing), () => listing),
  }),
  commands: [ReadListing({ pubkey: model.pubkey, slug: model.slug, fresh: true })],
})

const failedVersion = (mode: Mode, failure: PublishFailure): Mode =>
  Mode.guards.Editing(mode)
    ? Mode.Editing({ form: ListingForm.settled(mode.form), maybeFailure: Option.some(failure) })
    : Mode.Viewing({ maybeFailure: Option.some(failure) })

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    SucceededReadListing: ({ listing }) => ({
      model: modifyFields(model, { listing: () => ListingData.Success({ data: listing }) }),
    }),
    FailedReadListing: ({ problem }) => ({
      model: modifyFields(model, { listing: () => ListingData.Failure({ error: problem }) }),
    }),
    ClickedEdit: () =>
      Option.match(AsyncData.getData(model.listing), {
        onNone: () => ({ model }),
        onSome: (listing) =>
          Me.guards.Ready(model.me)
            ? {
                model: modifyFields(model, {
                  mode: () =>
                    Mode.Editing({
                      form: ListingForm.fromListing(model.language, listing),
                      maybeFailure: Option.none(),
                    }),
                }),
              }
            : { model, outMessage: OutMessage.SignerMissing() },
      }),
    ClickedCancelEdit: () => ({ model: modifyFields(model, { mode: () => viewing }) }),
    GotListingFormMessage: ({ message: formMessage }) => foldForm(model, formMessage),
    SucceededPublishVersion: () => reread(model, viewing),
    FailedPublishVersion: ({ failure }) => ({
      model: modifyFields(model, { mode: (mode) => failedVersion(mode, failure) }),
    }),
  })

// VIEW

const details = (h: Html.HtmlBuilder<Message>, model: Model, listing: IndexListingDetail) => {
  const language = model.language
  return h.section(styled(h, s.panel()), [
    h.p(styled(h, s.lede()), [listing.summary]),
    h.p([], [listing.description]),
    Ui.facts(h, [
      Ui.fact(h, say(language, 'listingPage.price'), listingPriceText(language, listing)),
      Ui.fact(
        h,
        say(language, 'listing.tags'),
        listing.topics.length === 0 ? say(language, 'listingPage.noTags') : listing.topics.join(', '),
      ),
      Ui.fact(
        h,
        say(language, 'listingPage.seller'),
        h.span(
          [h.Title(listing.pubkey)],
          [
            listing.author.name ?? shortNpub(listing.pubkey),
            ' ',
            listing.author.walletVerified
              ? Ui.chip(h, say(language, 'listingPage.walletLinked'), 'done')
              : Ui.chip(h, say(language, 'listingPage.noWallet')),
          ],
        ),
      ),
      Ui.fact(
        h,
        say(language, 'listingPage.state'),
        listing.status === 'active'
          ? Ui.chip(h, say(language, 'listingPage.active'), 'done')
          : Ui.chip(h, say(language, 'listingPage.sold')),
      ),
    ]),
  ])
}

const failureNotice = (h: Html.HtmlBuilder<Message>, model: Model, maybeFailure: Option.Option<PublishFailure>) =>
  Option.match(maybeFailure, {
    onNone: () => h.empty,
    onSome: (failure) =>
      publishFailureNotice(
        h,
        model.language,
        failure,
        identityHref(AppRoute.Listing({ pubkey: model.pubkey, slug: model.slug })),
      ),
  })

const sellerActions = (h: Html.HtmlBuilder<Message>, model: Model) =>
  Mode.match(model.mode, {
    Viewing: ({ maybeFailure }) =>
      h.div(styled(h, s.section()), [
        h.div(styled(h, s.actions()), [
          Ui.button(h, {
            label: say(model.language, 'listingPage.edit'),
            onClick: Message.ClickedEdit(),
            kind: 'primary',
          }),
        ]),
        h.p(styled(h, s.meta()), [say(model.language, 'listingPage.editNote')]),
        failureNotice(h, model, maybeFailure),
      ]),
    Editing: ({ form, maybeFailure }) =>
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
          failureNotice(h, model, maybeFailure),
          h.div(styled(h, s.actions()), [
            Ui.button(h, { label: say(model.language, 'common.cancel'), onClick: Message.ClickedCancelEdit() }),
          ]),
        ],
      ),
  })

export const view = Submodel.defineView<Model, Message>((model, h) =>
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
        payPerCallSection(h, model.language, listing),
        isSeller(model) ? sellerActions(h, model) : h.empty,
      ]),
  }),
)

/** The page's title, for the document. */
export const documentTitle = (model: Model): string =>
  Option.match(AsyncData.getData(model.listing), {
    onNone: () => say(model.language, 'listingPage.loading'),
    onSome: (listing) => listing.title,
  })
