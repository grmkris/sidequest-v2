import { format } from '@sidequest/i18n'
import { Cursor, Listing, OpenRequest, SearchText } from '@sidequest/protocol'
import { Effect, Option, Schema } from 'effect'
import { Command, type Html, Submodel, type Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { pushUrl } from 'foldkit/navigation'
import { modifyFields } from 'foldkit/struct'
import { formatAmount } from '../Amount.ts'
import { SidequestClient } from '../Api.ts'
import { Feed, feedView, loadingFeed, loadingMore, withPage, withProblem } from '../Feed.ts'
import type { Language } from '../Language.ts'
import { Problem, problemOf } from '../Problem.ts'
import { homeRouter, jobRouter, listingRouter, newListingRouter, newRequestRouter } from '../route.ts'
import { styled } from '../Styled.ts'
import { formatInstant, say } from '../Text.ts'
import * as Ui from '../Ui.ts'
import * as s from '../Ui.styles.ts'
import * as hs from './Home.styles.ts'

// What Sidequest is, the open requests and the listings, which anyone may read and search.

// MODEL

const RequestFeed = Feed(OpenRequest)
const ListingFeed = Feed(Listing)

export const Model = Schema.Struct({
  query: Schema.String,
  maybeSearched: Schema.Option(SearchText),
  requests: RequestFeed,
  listings: ListingFeed,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  UpdatedQuery: { value: Schema.String },
  SubmittedSearch: {},
  ClickedMoreRequests: {},
  ClickedMoreListings: {},
  SucceededReadRequests: { items: Schema.Array(OpenRequest), next: Schema.NullOr(Cursor) },
  FailedReadRequests: { problem: Problem },
  SucceededSearchListings: { items: Schema.Array(Listing), next: Schema.NullOr(Cursor) },
  FailedSearchListings: { problem: Problem },
  CompletedPushSearch: {},
})
export type Message = typeof Message.Type

// COMMAND

export const ReadRequests = Command.define('ReadRequests', {
  args: { maybeCursor: Schema.Option(Cursor) },
  messages: [Message.SucceededReadRequests, Message.FailedReadRequests],
  execute: ({ maybeCursor }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      const page = yield* api.jobs.open({ query: { cursor: Option.getOrUndefined(maybeCursor) } })
      return Message.SucceededReadRequests(page)
    }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedReadRequests({ problem: problemOf(error) })))),
})

export const SearchListings = Command.define('SearchListings', {
  args: { maybeQuery: Schema.Option(SearchText), maybeCursor: Schema.Option(Cursor) },
  messages: [Message.SucceededSearchListings, Message.FailedSearchListings],
  execute: ({ maybeQuery, maybeCursor }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      const page = yield* api.listings.search({
        query: { q: Option.getOrUndefined(maybeQuery), cursor: Option.getOrUndefined(maybeCursor) },
      })
      return Message.SucceededSearchListings(page)
    }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedSearchListings({ problem: problemOf(error) })))),
})

export const PushSearch = Command.define('PushSearch', {
  args: { maybeQuery: Schema.Option(SearchText) },
  messages: [Message.CompletedPushSearch],
  execute: ({ maybeQuery }) => pushUrl(homeRouter({ q: maybeQuery })).pipe(Effect.as(Message.CompletedPushSearch())),
})

// INIT

/** A search as the address names it, if it is one the API takes. */
const searchOf = (q: Option.Option<string>): Option.Option<typeof SearchText.Type> =>
  Option.flatMap(q, (text) => Schema.decodeUnknownOption(SearchText)(text.trim()))

type UpdateReturn = Update.Return<Model, Message, SidequestClient>

export const init = (q: Option.Option<string>): UpdateReturn => {
  const maybeSearched = searchOf(q)
  return {
    model: {
      query: Option.getOrElse(maybeSearched, () => ''),
      maybeSearched,
      requests: loadingFeed(),
      listings: loadingFeed(),
    },
    commands: [
      ReadRequests({ maybeCursor: Option.none() }),
      SearchListings({ maybeQuery: maybeSearched, maybeCursor: Option.none() }),
    ],
  }
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
    SucceededReadRequests: (page) => ({ model: modifyFields(model, { requests: (feed) => withPage(feed, page) }) }),
    FailedReadRequests: ({ problem }) => ({
      model: modifyFields(model, { requests: (feed) => withProblem(feed, problem) }),
    }),
    SucceededSearchListings: (page) => ({ model: modifyFields(model, { listings: (feed) => withPage(feed, page) }) }),
    FailedSearchListings: ({ problem }) => ({
      model: modifyFields(model, { listings: (feed) => withProblem(feed, problem) }),
    }),
    CompletedPushSearch: () => ({ model }),
  })

// VIEW

const requestRow = (h: Html.HtmlBuilder<Message>, language: Language, request: OpenRequest) => [
  h.a([h.Href(jobRouter({ job: request.id })), ...styled(h, s.rowTitle())], [request.title]),
  h.p(styled(h, s.meta()), [
    format(language, 'home.requests.until', { date: formatInstant(request.expiresAt, language) }),
  ]),
]

const listingRow = (h: Html.HtmlBuilder<Message>, language: Language, listing: Listing) => [
  h.a([h.Href(listingRouter({ listing: listing.id })), ...styled(h, s.rowTitle())], [listing.title]),
  h.p(styled(h, s.meta()), [
    Option.match(Option.fromNullishOr(listing.priceHint), {
      onNone: () => say(language, 'listing.noPrice'),
      onSome: (hint) =>
        format(language, 'listing.priceFrom', { price: formatAmount(hint.amount, hint.asset, language) }),
    }),
  ]),
  listing.tags.length === 0
    ? h.empty
    : h.ul(
        [h.AriaLabel(say(language, 'listing.tags')), ...styled(h, hs.tags())],
        listing.tags.map((tag) => h.keyed('li')(tag, [], [Ui.chip(h, tag)])),
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

export const view = Submodel.defineView<Model, Message, { readonly language: Language }>((model, { language }, h) =>
  h.div(styled(h, s.page()), [
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
          keyOf: (request) => request.id,
          row: (request) => requestRow(h, language, request),
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
          keyOf: (listing) => listing.id,
          row: (listing) => listingRow(h, language, listing),
        }),
      ],
    ),
  ]),
)
