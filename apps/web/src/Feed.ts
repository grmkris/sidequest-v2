import { Cursor } from '@sidequest/protocol'
import { Array, Option, Schema } from 'effect'
import type { Html } from 'foldkit'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'
import type { Language } from './Language.ts'
import { Problem } from './Problem.ts'
import { styled } from './Styled.ts'
import * as Ui from './Ui.ts'
import * as s from './Ui.styles.ts'

// A list the server pages with a cursor: what is shown, where the next page starts, and whether a page is on its way:
// the first, a further one, or the first again while what was shown stays.

const FeedStatus = defineTaggedUnion({
  Loading: {},
  Ready: {},
  LoadingMore: {},
  Refreshing: {},
  Failed: { problem: Problem },
})
type FeedStatus = typeof FeedStatus.Type

export const Feed = <Item extends Schema.Top>(item: Item) =>
  Schema.Struct({ items: Schema.Array(item), next: Schema.Option(Cursor), status: FeedStatus })

type AnyFeed<A> = {
  readonly items: ReadonlyArray<A>
  readonly next: Option.Option<Cursor>
  readonly status: FeedStatus
}

/** A list being read for the first time. */
export const loadingFeed = <A>(): AnyFeed<A> => ({ items: [], next: Option.none(), status: FeedStatus.Loading() })

/** A page arrived: the first one replaces what was shown, a further one adds to it. */
export const withPage = <A>(
  feed: AnyFeed<A>,
  page: { readonly items: ReadonlyArray<A>; readonly next: Cursor | null },
): AnyFeed<A> =>
  modifyFields(feed, {
    items: (items) => (FeedStatus.guards.LoadingMore(feed.status) ? Array.appendAll(items, page.items) : page.items),
    next: () => Option.fromNullishOr(page.next),
    status: () => FeedStatus.Ready(),
  })

/** A read failed; what was shown stays. */
export const withProblem = <A>(feed: AnyFeed<A>, problem: Problem): AnyFeed<A> =>
  modifyFields(feed, { status: () => FeedStatus.Failed({ problem }) })

/** The next page is on its way. */
export const loadingMore = <A>(feed: AnyFeed<A>): AnyFeed<A> =>
  modifyFields(feed, { status: () => FeedStatus.LoadingMore() })

export type FeedView<A, Message> = {
  readonly feed: AnyFeed<A>
  readonly language: Language
  readonly label: string
  readonly loading: string
  readonly empty: string
  readonly more: string
  readonly onMore: Message
  readonly keyOf: (item: A) => string
  readonly row: (item: A) => ReadonlyArray<Html.Html>
}

/** The list, its empty state, its problem and its Show more button. */
export const feedView = <A, Message>(h: Html.HtmlBuilder<Message>, config: FeedView<A, Message>): Html.Html =>
  h.div(styled(h, s.section()), [
    FeedStatus.guards.Loading(config.feed.status)
      ? Ui.waiting(h, config.loading)
      : Array.match(config.feed.items, {
          onEmpty: () => h.p(styled(h, s.meta()), [config.empty]),
          onNonEmpty: (items) =>
            h.ul(
              [h.AriaLabel(config.label), ...styled(h, s.rows())],
              Array.map(items, (item) => h.keyed('li')(config.keyOf(item), styled(h, s.row()), config.row(item))),
            ),
        }),
    FeedStatus.guards.Failed(config.feed.status)
      ? Ui.problemNotice(h, config.language, config.feed.status.problem)
      : h.empty,
    Option.isSome(config.feed.next)
      ? h.div(styled(h, s.actions()), [
          Ui.button(h, {
            label: config.more,
            onClick: config.onMore,
            busy: FeedStatus.guards.LoadingMore(config.feed.status),
          }),
        ])
      : h.empty,
  ])
