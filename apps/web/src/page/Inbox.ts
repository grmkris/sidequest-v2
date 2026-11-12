import { type Cursor, InboxEntry, type InboxKind, maxPageSize } from '@sidequest/protocol'
import { Array, Effect, Option, Schema } from 'effect'
import { AsyncData, Command, type Html, Submodel, type Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'
import { type SidequestApiClient, SidequestClient } from '../Api.ts'
import { signedInOnly } from '../Gate.ts'
import { Language } from '../Language.ts'
import { Problem, problemOf } from '../Problem.ts'
import { AppRoute, jobRouter } from '../route.ts'
import type { Session } from '../Session.ts'
import { styled } from '../Styled.ts'
import { formatInstant, type PlainKey, say } from '../Text.ts'
import * as Ui from '../Ui.ts'
import * as s from '../Ui.styles.ts'

// What happened that concerns the signed-in person, newest first, each linking to its job.

// MODEL

const Entries = AsyncData.Schema(Schema.Array(InboxEntry), Problem)

export const Model = Schema.Struct({ language: Language, entries: Entries.schema })
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  SucceededReadInbox: { entries: Schema.Array(InboxEntry) },
  FailedReadInbox: { problem: Problem },
  ClickedRefresh: {},
})
export type Message = typeof Message.Type

// COMMAND

/** The API reads the inbox oldest first, a page at a time; the page shows the newest first, so it reads up to this
 * many pages and turns them around. */
const mostPages = 10

const readFrom = (
  api: SidequestApiClient,
  cursor: Cursor | undefined,
  read: ReadonlyArray<InboxEntry>,
  pages: number,
): Effect.Effect<ReadonlyArray<InboxEntry>, unknown> =>
  api.inbox.read({ query: { cursor, limit: maxPageSize } }).pipe(
    Effect.flatMap((page) => {
      const all = Array.appendAll(read, page.items)
      return page.more && pages + 1 < mostPages ? readFrom(api, page.next, all, pages + 1) : Effect.succeed(all)
    }),
  )

export const ReadInbox = Command.define('ReadInbox', {
  messages: [Message.SucceededReadInbox, Message.FailedReadInbox],
  execute: Effect.gen(function* () {
    const api = yield* (yield* SidequestClient).api
    const entries = yield* readFrom(api, undefined, [], 0)
    return Message.SucceededReadInbox({ entries: Array.reverse(entries) })
  }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedReadInbox({ problem: problemOf(error) })))),
})

// INIT

type UpdateReturn = Update.Return<Model, Message, SidequestClient>

export const init = (language: Language, mayRead: boolean): UpdateReturn =>
  mayRead
    ? { model: { language, entries: AsyncData.Loading() }, commands: [ReadInbox()] }
    : { model: { language, entries: AsyncData.Idle() } }

// UPDATE

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    SucceededReadInbox: ({ entries }) => ({
      model: modifyFields(model, { entries: () => Entries.Success({ data: entries }) }),
    }),
    FailedReadInbox: ({ problem }) => ({
      model: modifyFields(model, { entries: () => Entries.Failure({ error: problem }) }),
    }),
    ClickedRefresh: () => ({
      model: modifyFields(model, {
        entries: (entries) => Option.getOrElse(AsyncData.revalidateOrLoad(entries), () => entries),
      }),
      commands: [ReadInbox()],
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

const entryRow = (h: Html.HtmlBuilder<Message>, language: Language, entry: InboxEntry) => [
  h.a([h.Href(jobRouter({ job: entry.job })), ...styled(h, s.rowTitle())], [say(language, kindKeys[entry.kind])]),
  h.p(styled(h, s.meta()), [
    h.time([h.Datetime(new Date(entry.at * 1000).toISOString())], [formatInstant(entry.at, language)]),
  ]),
]

const entriesView = (h: Html.HtmlBuilder<Message>, model: Model) => {
  const language = model.language
  return AsyncData.matchData(model.entries, {
    onEmpty: () => Ui.waiting(h, say(language, 'inbox.loading')),
    onFailure: (problem) => Ui.problemNotice(h, language, problem),
    onData: (entries) =>
      h.div(styled(h, s.section()), [
        h.div(styled(h, s.actions()), [
          Ui.button(h, {
            label: say(language, 'inbox.refresh'),
            onClick: Message.ClickedRefresh(),
            busy: AsyncData.isRefreshing(model.entries),
          }),
        ]),
        Array.match(entries, {
          onEmpty: () => h.p(styled(h, s.meta()), [say(language, 'inbox.empty')]),
          onNonEmpty: (items) =>
            h.ul(
              [h.AriaLabel(say(language, 'inbox.title')), ...styled(h, s.rows())],
              Array.map(items, (entry) => h.keyed('li')(entry.id, styled(h, s.row()), entryRow(h, language, entry))),
            ),
        }),
      ]),
  })
}

export const view = Submodel.defineView<Model, Message, { readonly session: Session }>((model, { session }, h) =>
  h.div(styled(h, s.page()), [
    Ui.pageHead(h, say(model.language, 'inbox.title'), [say(model.language, 'inbox.lede')]),
    signedInOnly(h, { language: model.language, session, route: AppRoute.Inbox() }, () => entriesView(h, model)),
  ]),
)
