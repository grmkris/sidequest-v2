import { format } from '@sidequest/i18n'
import { Array, Option } from 'effect'
import { AsyncData, type Html, Submodel } from 'foldkit'
import { signerOnly } from '../Gate.ts'
import type { Language } from '../Language.ts'
import { nameOf, type Names } from '../Names.ts'
import { AppRoute, jobRouter } from '../route.ts'
import { styled } from '../Styled.ts'
import { formatInstant, say } from '../Text.ts'
import * as Ui from '../Ui.ts'
import * as s from '../Ui.styles.ts'
import { Message, type Model } from './Inbox.ts'
import { type InboxItem, type ItemKind, itemsOf } from './InboxItems.ts'

type ViewInputs = { readonly timeZone: string }

/** What the item says, in one sentence. */
const itemText = (language: Language, names: Names, timeZone: string, item: InboxItem): string => {
  const person = Option.match(item.maybePerson, { onNone: () => '', onSome: (pubkey) => nameOf(names, pubkey) })
  const date = Option.match(item.maybeAt, {
    onNone: () => '',
    onSome: (at) => formatInstant(at, language, timeZone),
  })
  const title = item.title
  const texts: Readonly<Record<ItemKind, () => string>> = {
    proposal: () => format(language, 'inbox.item.proposal', { person, title }),
    accepted: () => format(language, 'inbox.item.accepted', { person, title }),
    funded: () => format(language, 'inbox.item.funded', { title, date }),
    delivered: () => format(language, 'inbox.item.delivered', { person, title, date }),
    rejected: () => format(language, 'inbox.item.rejected', { title, date }),
    review: () => format(language, 'inbox.item.review', { person, title }),
    messages: () => format(language, 'inbox.item.messages', { count: item.count, title }),
  }
  return texts[item.kind]()
}

const itemRow = (h: Html.HtmlBuilder<Message>, model: Model, timeZone: string, item: InboxItem) =>
  h.keyed('li')(item.key, styled(h, s.row()), [
    h.p(styled(h, s.rowTitle()), [
      h.a([h.Href(jobRouter({ job: item.job }))], [itemText(model.language, model.names, timeZone, item)]),
      model.seen.includes(item.key) ? h.empty : h.span([], [' ', Ui.chip(h, say(model.language, 'inbox.new'), 'done')]),
    ]),
  ])

const itemsView = (h: Html.HtmlBuilder<Message>, model: Model, timeZone: string, pubkey: string) =>
  AsyncData.matchData(model.jobs, {
    onEmpty: () => Ui.waiting(h, say(model.language, 'inbox.loading')),
    onFailure: (problem) => Ui.problemNotice(h, model.language, problem),
    onData: (jobs) =>
      Array.match(itemsOf(pubkey, jobs, model.unread), {
        onEmpty: () => h.p(styled(h, s.meta()), [say(model.language, 'inbox.empty')]),
        onNonEmpty: (items) =>
          h.ul(
            [h.AriaLabel(say(model.language, 'inbox.title')), ...styled(h, s.rows())],
            Array.map(items, (item) => itemRow(h, model, timeZone, item)),
          ),
      }),
  })

const inboxView = (h: Html.HtmlBuilder<Message>, model: Model, timeZone: string, pubkey: string) =>
  h.div(styled(h, s.section()), [
    h.div(styled(h, s.actions()), [
      Ui.button(h, {
        label: say(model.language, 'inbox.refresh'),
        onClick: Message.ClickedRefresh(),
        busy: AsyncData.isLoading(model.jobs) || AsyncData.isRefreshing(model.jobs),
      }),
      Ui.button(h, { label: say(model.language, 'inbox.markAllRead'), onClick: Message.ClickedMarkAllRead() }),
    ]),
    itemsView(h, model, timeZone, pubkey),
    h.p(styled(h, s.hint()), [say(model.language, 'inbox.private')]),
  ])

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, { timeZone }, h) =>
  h.div(styled(h, s.page()), [
    Ui.pageHead(h, say(model.language, 'inbox.title'), [say(model.language, 'inbox.lede')]),
    signerOnly(h, { language: model.language, me: model.me, route: AppRoute.Inbox() }, (identity) =>
      inboxView(h, model, timeZone, identity.pubkey),
    ),
  ]),
)
