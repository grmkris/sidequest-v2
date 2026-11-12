import { Cursor, InboxEntry, type InboxKind } from '@sidequest/protocol'
import { Effect, Option, Schema } from 'effect'
import { Command, type Html, Submodel, type Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'
import { SidequestClient } from '../Api.ts'
import { Feed, feedView, isRefreshing, loadingFeed, loadingMore, refreshing, withPage, withProblem } from '../Feed.ts'
import { signedInOnly } from '../Gate.ts'
import { Language } from '../Language.ts'
import type { RecentInbox } from '../Preload.ts'
import { Problem, problemOf } from '../Problem.ts'
import { AppRoute, jobRouter } from '../route.ts'
import type { Session } from '../Session.ts'
import { styled } from '../Styled.ts'
import { formatInstant, type PlainKey, say } from '../Text.ts'
import * as Ui from '../Ui.ts'
import * as s from '../Ui.styles.ts'

// What happened that concerns the signed-in person, newest first, each linking to its job: a page at a time back from
// the newest item, and the newest page again on request.

// MODEL

const EntryFeed = Feed(InboxEntry)

export const Model = Schema.Struct({ language: Language, entries: EntryFeed })
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  SucceededReadInbox: { items: Schema.Array(InboxEntry), next: Schema.NullOr(Cursor) },
  FailedReadInbox: { problem: Problem },
  ClickedRefresh: {},
  ClickedOlder: {},
})
export type Message = typeof Message.Type

// COMMAND

/** A page of the inbox, newest first: the newest page, or the one older than a cursor. */
export const ReadInbox = Command.define('ReadInbox', {
  args: { maybeCursor: Schema.Option(Cursor) },
  messages: [Message.SucceededReadInbox, Message.FailedReadInbox],
  execute: ({ maybeCursor }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      const page = yield* api.inbox.recent({ query: { cursor: Option.getOrUndefined(maybeCursor) } })
      return Message.SucceededReadInbox({ items: page.items, next: page.next })
    }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedReadInbox({ problem: problemOf(error) })))),
})

// INIT

type UpdateReturn = Update.Return<Model, Message, SidequestClient>

/** The newest page the server read, or a read of it when the person may be signed in. */
export const init = (language: Language, mayRead: boolean, maybeRecent: Option.Option<RecentInbox>): UpdateReturn =>
  Option.match(maybeRecent, {
    onSome: (recent) => ({ model: { language, entries: withPage(loadingFeed(), recent) } }),
    onNone: () =>
      mayRead
        ? { model: { language, entries: loadingFeed() }, commands: [ReadInbox({ maybeCursor: Option.none() })] }
        : { model: { language, entries: loadingFeed() } },
  })

// UPDATE

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    SucceededReadInbox: (page) => ({ model: modifyFields(model, { entries: (feed) => withPage(feed, page) }) }),
    FailedReadInbox: ({ problem }) => ({
      model: modifyFields(model, { entries: (feed) => withProblem(feed, problem) }),
    }),
    ClickedRefresh: () => ({
      model: modifyFields(model, { entries: refreshing }),
      commands: [ReadInbox({ maybeCursor: Option.none() })],
    }),
    ClickedOlder: () => ({
      model: modifyFields(model, { entries: loadingMore }),
      commands: [ReadInbox({ maybeCursor: model.entries.next })],
    }),
  })

// VIEW

const kindKeys: Readonly<Record<InboxKind, PlainKey>> = {
  proposal_submitted: 'inbox.kind.proposalSubmitted',
  change_requested: 'inbox.kind.changeRequested',
  proposal_accepted: 'inbox.kind.proposalAccepted',
  funding_recorded: 'inbox.kind.fundingRecorded',
  delivery_recorded: 'inbox.kind.deliveryRecorded',
  job_settled: 'inbox.kind.jobSettled',
  message_posted: 'inbox.kind.messagePosted',
}

type ViewInputs = { readonly session: Session; readonly timeZone: string }

const entryRow = (h: Html.HtmlBuilder<Message>, language: Language, timeZone: string, entry: InboxEntry) => [
  h.a([h.Href(jobRouter({ job: entry.job })), ...styled(h, s.rowTitle())], [say(language, kindKeys[entry.kind])]),
  h.p(styled(h, s.meta()), [
    h.time([h.Datetime(new Date(entry.at * 1000).toISOString())], [formatInstant(entry.at, language, timeZone)]),
  ]),
]

const entriesView = (h: Html.HtmlBuilder<Message>, model: Model, timeZone: string) => {
  const language = model.language
  return h.div(styled(h, s.section()), [
    h.div(styled(h, s.actions()), [
      Ui.button(h, {
        label: say(language, 'inbox.refresh'),
        onClick: Message.ClickedRefresh(),
        busy: isRefreshing(model.entries),
      }),
    ]),
    feedView(h, {
      feed: model.entries,
      language,
      label: say(language, 'inbox.title'),
      loading: say(language, 'inbox.loading'),
      empty: say(language, 'inbox.empty'),
      more: say(language, 'common.showMore'),
      onMore: Message.ClickedOlder(),
      keyOf: (entry) => entry.id,
      row: (entry) => entryRow(h, language, timeZone, entry),
    }),
  ])
}

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, { session, timeZone }, h) =>
  h.div(styled(h, s.page()), [
    Ui.pageHead(h, say(model.language, 'inbox.title'), [say(model.language, 'inbox.lede')]),
    signedInOnly(h, { language: model.language, session, route: AppRoute.Inbox() }, () =>
      entriesView(h, model, timeZone),
    ),
  ]),
)
