import { format } from '@sidequest/i18n'
import { OpenJob } from '../OpenJob.ts'
import { Cursor, IndexListing, SearchText } from '@sidequest/protocol'
import { Array, Effect, Option, Schema } from 'effect'
import { Command, type Html, Submodel, type Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { pushUrl } from 'foldkit/navigation'
import { modifyFields } from 'foldkit/struct'
import { formatAmount } from '../Amount.ts'
import { SidequestClient } from '../Api.ts'
import { Feed, feedView, loadingFeed, loadingMore, withPage, withProblem } from '../Feed.ts'
import type { Language } from '../Language.ts'
import { defineReadNames, Names, nameOf, shortNpub, unnamed, withNames } from '../Names.ts'
import type { Preload } from '../Preload.ts'
import { failedWith, Problem } from '../Problem.ts'
import { homeRouter, jobRouter, listingRouter, newListingRouter, newRequestRouter } from '../route.ts'
import { styled } from '../Styled.ts'
import { formatInstant, say } from '../Text.ts'
import * as Ui from '../Ui.ts'
import * as s from '../Ui.styles.ts'
import * as hs from './Home.styles.ts'

// What Sidequest is, the open requests and the listings, which anyone may read and search: signed Nostr events as the
// index holds them, each with the name of the key behind it.

// MODEL

const RequestFeed = Feed(OpenJob)
const ListingFeed = Feed(IndexListing)

export const Model = Schema.Struct({
  query: Schema.String,
  maybeSearched: Schema.Option(SearchText),
  requests: RequestFeed,
  listings: ListingFeed,
  names: Names,
  askedNames: Schema.Array(Schema.String),
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  UpdatedQuery: { value: Schema.String },
  SubmittedSearch: {},
  ClickedMoreRequests: {},
  ClickedMoreListings: {},
  SucceededReadRequests: { items: Schema.Array(OpenJob), next: Schema.NullOr(Cursor) },
  FailedReadRequests: { problem: Problem },
  SucceededSearchListings: { items: Schema.Array(IndexListing), next: Schema.NullOr(Cursor) },
  FailedSearchListings: { problem: Problem },
  CompletedPushSearch: {},
  SucceededReadNames: { names: Names },
  FailedReadNames: { problem: Problem },
})
export type Message = typeof Message.Type

// COMMAND

/** The open requests that have not expired, newest first. */
export const ReadRequests = Command.define('ReadRequests', {
  args: { maybeCursor: Schema.Option(Cursor) },
  messages: [Message.SucceededReadRequests, Message.FailedReadRequests],
  execute: ({ maybeCursor }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      const page = yield* api.indexJobs.openJobs({
        query: { stage: 'open', expired: 'exclude', cursor: Option.getOrUndefined(maybeCursor) },
      })
      return Message.SucceededReadRequests(page)
    }).pipe(Effect.catch(failedWith(Message.FailedReadRequests))),
})

export const SearchListings = Command.define('SearchListings', {
  args: { maybeQuery: Schema.Option(SearchText), maybeCursor: Schema.Option(Cursor) },
  messages: [Message.SucceededSearchListings, Message.FailedSearchListings],
  execute: ({ maybeQuery, maybeCursor }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      const page = yield* api.events.listings({
        query: { q: Option.getOrUndefined(maybeQuery), cursor: Option.getOrUndefined(maybeCursor) },
      })
      return Message.SucceededSearchListings(page)
    }).pipe(Effect.catch(failedWith(Message.FailedSearchListings))),
})

export const PushSearch = Command.define('PushSearch', {
  args: { maybeQuery: Schema.Option(SearchText) },
  messages: [Message.CompletedPushSearch],
  execute: ({ maybeQuery }) => pushUrl(homeRouter({ q: maybeQuery })).pipe(Effect.as(Message.CompletedPushSearch())),
})

export const ReadNames = defineReadNames(Message.SucceededReadNames, Message.FailedReadNames)

// INIT

/** A search as the address names it, if it is one the index takes. */
export const searchOf = (q: Option.Option<string>): Option.Option<typeof SearchText.Type> =>
  Option.flatMap(q, (text) => Schema.decodeUnknownOption(SearchText)(text.trim()))

type UpdateReturn = Update.Return<Model, Message, SidequestClient>

type HomePreload = Extract<Preload, { readonly _tag: 'Home' }>

/** The buyers the requests name; a listing carries its seller's name itself. */
export const buyersOf = (requests: ReadonlyArray<OpenJob>): ReadonlyArray<string> =>
  Array.map(requests, (request) => request.buyer)

export const init = (q: Option.Option<string>, maybePreload: Option.Option<HomePreload>): UpdateReturn => {
  const maybeSearched = searchOf(q)
  const query = Option.getOrElse(maybeSearched, () => '')
  return Option.match(maybePreload, {
    onSome: ({ requests, listings, names }) => ({
      model: {
        query,
        maybeSearched,
        requests: withPage(loadingFeed(), requests),
        listings: withPage(loadingFeed(), listings),
        names,
        // The server asked for every name these pages show; one it did not find is not asked for again.
        askedNames: buyersOf(requests.items),
      },
    }),
    onNone: () => ({
      model: { query, maybeSearched, requests: loadingFeed(), listings: loadingFeed(), names: [], askedNames: [] },
      commands: [
        ReadRequests({ maybeCursor: Option.none() }),
        SearchListings({ maybeQuery: maybeSearched, maybeCursor: Option.none() }),
      ],
    }),
  })
}

/** The address's search changed (a search was submitted, or Back): search again, and keep the requests. */
export const searchChanged = (model: Model, q: Option.Option<string>): UpdateReturn => {
  const maybeSearched = searchOf(q)
  return {
    model: modifyFields(model, {
      query: () => Option.getOrElse(maybeSearched, () => ''),
      maybeSearched: () => maybeSearched,
      listings: () => loadingFeed(),
    }),
    commands: [SearchListings({ maybeQuery: maybeSearched, maybeCursor: Option.none() })],
  }
}

// UPDATE

/** Ask for the names of the keys not known or asked for yet. */
const askNames = (model: Model, pubkeys: ReadonlyArray<string>): UpdateReturn =>
  Array.match(unnamed(pubkeys, model.names, model.askedNames), {
    onEmpty: () => ({ model }),
    onNonEmpty: (missing) => ({
      model: modifyFields(model, { askedNames: Array.appendAll(missing) }),
      commands: [ReadNames({ pubkeys: missing })],
    }),
  })

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    UpdatedQuery: ({ value }) => ({ model: modifyFields(model, { query: () => value }) }),
    SubmittedSearch: () => ({ model, commands: [PushSearch({ maybeQuery: searchOf(Option.some(model.query)) })] }),
    ClickedMoreRequests: () => ({
      model: modifyFields(model, { requests: loadingMore }),
      commands: [ReadRequests({ maybeCursor: model.requests.next })],
    }),
    ClickedMoreListings: () => ({
      model: modifyFields(model, { listings: loadingMore }),
      commands: [SearchListings({ maybeQuery: model.maybeSearched, maybeCursor: model.listings.next })],
    }),
    SucceededReadRequests: (page) =>
      askNames(modifyFields(model, { requests: (feed) => withPage(feed, page) }), buyersOf(page.items)),
    FailedReadRequests: ({ problem }) => ({
      model: modifyFields(model, { requests: (feed) => withProblem(feed, problem) }),
    }),
    SucceededSearchListings: (page) => ({ model: modifyFields(model, { listings: (feed) => withPage(feed, page) }) }),
    FailedSearchListings: ({ problem }) => ({
      model: modifyFields(model, { listings: (feed) => withProblem(feed, problem) }),
    }),
    CompletedPushSearch: () => ({ model }),
    SucceededReadNames: ({ names }) => ({ model: modifyFields(model, { names: (known) => withNames(known, names) }) }),
    FailedReadNames: () => ({ model }),
  })

// VIEW

type ViewInputs = { readonly language: Language; readonly timeZone: string }

const requestRow = (h: Html.HtmlBuilder<Message>, model: Model, inputs: ViewInputs, open: OpenJob) => [
  h.a([h.Href(jobRouter({ job: open.job })), ...styled(h, s.rowTitle())], [open.request.title]),
  h.p(styled(h, s.meta()), [
    format(inputs.language, 'home.requests.byUntil', {
      name: nameOf(model.names, open.buyer),
      date: formatInstant(open.request.expiresAt, inputs.language, inputs.timeZone),
    }),
  ]),
  open.proposals === 0
    ? h.empty
    : h.p(styled(h, s.meta()), [format(inputs.language, 'home.requests.proposals', { count: open.proposals })]),
]

/** A listing's price hint, if it has one. */
export const priceText = (language: Language, price: IndexListing['price']): string =>
  Option.match(Option.fromNullishOr(price), {
    onNone: () => say(language, 'listing.noPrice'),
    onSome: (hint) => format(language, 'listing.priceFrom', { price: formatAmount(hint.amount, hint.asset, language) }),
  })

const listingRow = (h: Html.HtmlBuilder<Message>, language: Language, listing: IndexListing) => [
  h.a(
    [h.Href(listingRouter({ pubkey: listing.pubkey, slug: listing.slug })), ...styled(h, s.rowTitle())],
    [listing.title],
  ),
  h.p(styled(h, s.meta()), [listing.summary]),
  h.p(styled(h, s.meta()), [
    format(language, 'listing.by', { name: listing.author.name ?? shortNpub(listing.pubkey) }),
    ' · ',
    priceText(language, listing.price),
  ]),
  listing.topics.length === 0
    ? h.empty
    : h.ul(
        [h.AriaLabel(say(language, 'listing.tags')), ...styled(h, hs.tags())],
        listing.topics.map((topic) => h.keyed('li')(topic, [], [Ui.chip(h, topic)])),
      ),
]

const searchForm = (h: Html.HtmlBuilder<Message>, language: Language, model: Model) =>
  h.form(
    [h.Role('search'), h.OnSubmit(Message.SubmittedSearch()), ...styled(h, hs.search())],
    [
      h.label([h.For('listing-search'), ...styled(h, s.visuallyHidden())], [say(language, 'home.listings.search')]),
      h.input([
        h.Id('listing-search'),
        h.Type('search'),
        h.Name('q'),
        h.Value(model.query),
        h.OnInput((value) => Message.UpdatedQuery({ value })),
        h.Placeholder(say(language, 'home.listings.searchPlaceholder')),
        h.EnterKeyHint('search'),
        h.Maxlength(100),
        ...styled(h, s.input()),
      ]),
      Ui.submit(h, { label: say(language, 'home.listings.searchButton'), busy: false, kind: 'secondary' }),
    ],
  )

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) => {
  const language = inputs.language
  return h.div(styled(h, s.page()), [
    h.header(styled(h, hs.hero()), [
      h.h1(styled(h, hs.heroTitle()), [say(language, 'home.title')]),
      h.p(styled(h, s.lede()), [say(language, 'home.lede')]),
      h.div(styled(h, s.actions()), [
        Ui.actionLink(h, { label: say(language, 'home.postRequest'), href: newRequestRouter() }),
        Ui.actionLink(h, { label: say(language, 'home.publishListing'), href: newListingRouter(), kind: 'secondary' }),
      ]),
    ]),
    h.section(
      [h.AriaLabelledBy('open-requests'), ...styled(h, s.section())],
      [
        h.h2([h.Id('open-requests')], [say(language, 'home.requests.title')]),
        feedView(h, {
          feed: model.requests,
          language,
          label: say(language, 'home.requests.title'),
          loading: say(language, 'home.requests.loading'),
          empty: say(language, 'home.requests.empty'),
          more: say(language, 'common.showMore'),
          onMore: Message.ClickedMoreRequests(),
          keyOf: (open) => open.job,
          row: (open) => requestRow(h, model, inputs, open),
        }),
      ],
    ),
    h.section(
      [h.AriaLabelledBy('listings'), ...styled(h, s.section())],
      [
        h.h2([h.Id('listings')], [say(language, 'home.listings.title')]),
        searchForm(h, language, model),
        feedView(h, {
          feed: model.listings,
          language,
          label: say(language, 'home.listings.title'),
          loading: say(language, 'home.listings.loading'),
          empty: Option.isSome(model.maybeSearched)
            ? say(language, 'home.listings.noMatch')
            : say(language, 'home.listings.empty'),
          more: say(language, 'common.showMore'),
          onMore: Message.ClickedMoreListings(),
          keyOf: (listing) => `${listing.pubkey}:${listing.slug}`,
          row: (listing) => listingRow(h, language, listing),
        }),
      ],
    ),
  ])
})
