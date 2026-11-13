import { format } from '@sidequest/i18n'
import type { JobView, ReviewView } from '@sidequest/fold'
import { Array, Option } from 'effect'
import type { Html } from 'foldkit'
import type { Language } from '../../Language.ts'
import { type Names, nameOf } from '../../Names.ts'
import { styled } from '../../Styled.ts'
import { say } from '../../Text.ts'
import * as Ui from '../../Ui.ts'
import * as s from '../../Ui.styles.ts'
import * as js from './Job.styles.ts'

// Once the job settled, each side may review the other. The fold counts one review per side (the latest by its
// author's clock) from a key linked to that side's wallet; the page shows those, labelled by side.

const sideKeys = { payer: 'job.reviews.fromBuyer', receiver: 'job.reviews.fromWorker' } as const

const reviewRow = <M>(h: Html.HtmlBuilder<M>, language: Language, names: Names, review: ReviewView) =>
  h.keyed('li')(review.id, styled(h, s.row()), [
    h.p(styled(h, s.rowTitle()), [
      nameOf(names, review.author),
      ' ',
      Ui.chip(h, say(language, review.side === null ? 'job.reviews.fromBuyer' : sideKeys[review.side])),
      ' ',
      Ui.chip(h, format(language, 'review.stars', { count: review.content.rating }), 'done'),
    ]),
    h.p(styled(h, js.description()), [review.content.text]),
  ])

/** The counted reviews, and where the person may write theirs: `form` when they are a side the fold would count. */
export const reviewsSection = <M>(
  h: Html.HtmlBuilder<M>,
  config: {
    readonly view: JobView
    readonly language: Language
    readonly names: Names
    readonly maybeForm: Option.Option<Html.Html>
  },
): Html.Html => {
  const { view, language, names, maybeForm } = config
  const counted = Array.filter(view.reviews, (review) => review.status === 'counted')
  if (Array.isReadonlyArrayEmpty(counted) && Option.isNone(maybeForm)) {
    return h.empty
  }
  return h.section(
    [h.AriaLabelledBy('job-reviews'), ...styled(h, s.section())],
    [
      h.h2([h.Id('job-reviews')], [say(language, 'job.reviews.title')]),
      Array.match(counted, {
        onEmpty: () => h.p(styled(h, s.meta()), [say(language, 'job.reviews.none')]),
        onNonEmpty: (shown) =>
          h.ul(
            [h.AriaLabel(say(language, 'job.reviews.title')), ...styled(h, s.rows())],
            Array.map(shown, (review) => reviewRow(h, language, names, review)),
          ),
      }),
      Option.match(maybeForm, {
        onNone: () => h.empty,
        onSome: (form) => h.div(styled(h, s.panel()), [h.h3([], [say(language, 'job.reviews.yours')]), form]),
      }),
    ],
  )
}
