import { format } from '@sidequest/i18n'
import type {
  AccountId,
  Agreement,
  BidderJobView,
  BuyerJobView,
  Proposal,
  ProposalRef,
  Review,
} from '@sidequest/protocol'
import { Array, Option } from 'effect'
import type { Html } from 'foldkit'
import { formatAmount } from '../../Amount.ts'
import type { Language } from '../../Language.ts'
import { styled } from '../../Styled.ts'
import { formatInstant, say, shortId } from '../../Text.ts'
import * as Ui from '../../Ui.ts'
import * as s from '../../Ui.styles.ts'
import { Decision, headOf, Message, versionsOf } from './Job.ts'
import * as js from './Job.styles.ts'
import { termsView } from './TermsView.ts'

// Proposals as the buyer sees them (every bidder's, newest version first, with the decision on it) and as a bidder sees
// their own; the agreement; the reviews.

const refOf = (proposal: Proposal): ProposalRef => ({
  bidder: proposal.bidder,
  version: proposal.version,
  termsDigest: proposal.termsDigest,
})

const sameRef = (left: ProposalRef, right: ProposalRef) =>
  left.bidder === right.bidder && left.version === right.version && left.termsDigest === right.termsDigest

const versionBody = (h: Html.HtmlBuilder<Message>, language: Language, proposal: Proposal) => [
  h.h4(styled(h, js.versionTitle()), [proposal.terms.title]),
  termsView(h, language, proposal.terms),
  h.p(styled(h, s.meta()), [say(language, 'job.digest'), ' ', Ui.dataText(h, proposal.termsDigest)]),
]

const earlier = (h: Html.HtmlBuilder<Message>, language: Language, versions: ReadonlyArray<Proposal>) =>
  Array.match(versions, {
    onEmpty: () => h.empty,
    onNonEmpty: (older) =>
      h.details(styled(h, js.earlier()), [
        h.summary([], [format(language, 'job.earlierVersions', { count: older.length })]),
        ...Array.map(Array.reverse(older), (proposal) =>
          h.keyed('div')(proposal.id, styled(h, js.version()), [
            Ui.chip(h, format(language, 'job.version', { version: proposal.version })),
            ...versionBody(h, language, proposal),
          ]),
        ),
      ]),
  })

const confirmAccept = (h: Html.HtmlBuilder<Message>, language: Language, head: Proposal) =>
  h.div(
    [h.Role('group'), h.AriaLabel(say(language, 'job.confirmAcceptLabel')), ...styled(h, js.slip())],
    [
      h.p(
        [],
        [
          format(language, 'job.confirmAccept', {
            version: head.version,
            bidder: shortId(head.bidder),
            amount: formatAmount(head.terms.amount, head.terms.asset, language),
            deadline: formatInstant(head.terms.deliveryDeadline, language),
          }),
        ],
      ),
      h.div(styled(h, s.actions()), [
        Ui.button(h, {
          label: format(language, 'job.accept', { version: head.version }),
          onClick: Message.ClickedConfirmAccept(),
          kind: 'primary',
        }),
        Ui.button(h, { label: say(language, 'common.cancel'), onClick: Message.ClickedKeep() }),
      ]),
    ],
  )

const headActions = (
  h: Html.HtmlBuilder<Message>,
  language: Language,
  view: BuyerJobView,
  head: Proposal,
  decision: Decision,
) => {
  const ref = refOf(head)
  const changeAsked = Array.some(view.changesRequested, (asked) => sameRef(asked, ref))
  if (view.state !== 'Open') {
    return h.empty
  }
  if (Decision.guards.ConfirmingAccept(decision) && sameRef(decision.ref, ref)) {
    return confirmAccept(h, language, head)
  }
  const busy =
    (Decision.guards.Accepting(decision) || Decision.guards.RequestingChange(decision)) && sameRef(decision.ref, ref)
  return h.div(styled(h, s.actions()), [
    Ui.button(h, {
      label: format(language, 'job.accept', { version: head.version }),
      onClick: Message.ClickedAccept({ ref }),
      kind: 'primary',
      busy: busy && Decision.guards.Accepting(decision),
    }),
    changeAsked
      ? Ui.chip(h, say(language, 'job.changeAsked'), 'seal')
      : Ui.button(h, {
          label: say(language, 'job.askChange'),
          onClick: Message.ClickedRequestChange({ ref }),
          busy: busy && Decision.guards.RequestingChange(decision),
        }),
  ])
}

const bidderCard = (
  h: Html.HtmlBuilder<Message>,
  language: Language,
  view: BuyerJobView,
  bidder: AccountId,
  decision: Decision,
) =>
  Option.match(headOf(view.proposals, bidder), {
    onNone: () => h.empty,
    onSome: (head) =>
      h.keyed('article')(bidder, styled(h, s.panel()), [
        h.header(styled(h, s.sectionHead()), [
          h.h3([], [format(language, 'job.fromBidder', { bidder: shortId(bidder) })]),
          Ui.chip(h, format(language, 'job.latestVersion', { version: head.version })),
        ]),
        ...versionBody(h, language, head),
        headActions(h, language, view, head, decision),
        earlier(h, language, Array.dropRight(versionsOf(view.proposals, bidder), 1)),
      ]),
  })

/** Every bidder's proposal, for the buyer. */
export const buyerProposals = (
  h: Html.HtmlBuilder<Message>,
  language: Language,
  view: BuyerJobView,
  decision: Decision,
): Html.Html =>
  h.section(
    [h.AriaLabelledBy('job-proposals'), ...styled(h, s.section())],
    [
      h.h2([h.Id('job-proposals')], [say(language, 'job.proposals')]),
      Array.match(Array.dedupe(Array.map(view.proposals, (proposal) => proposal.bidder)), {
        onEmpty: () => h.p(styled(h, s.meta()), [say(language, 'job.noProposals')]),
        onNonEmpty: (bidders) =>
          h.div(
            styled(h, s.section()),
            Array.map(bidders, (bidder) => bidderCard(h, language, view, bidder, decision)),
          ),
      }),
    ],
  )

/** A bidder's own proposals, newest first, and where their bid stands. */
export const bidderProposals = (h: Html.HtmlBuilder<Message>, language: Language, view: BidderJobView): Html.Html =>
  h.section(
    [h.AriaLabelledBy('job-proposals'), ...styled(h, s.section())],
    [
      h.h2([h.Id('job-proposals')], [say(language, 'job.yourProposals')]),
      view.outcome === 'won'
        ? Ui.notice(h, 'done', [h.p([], [say(language, 'job.won')])])
        : view.outcome === 'lost'
          ? Ui.notice(h, 'neutral', [h.p([], [say(language, 'job.lost')])])
          : h.empty,
      ...Array.map(Array.reverse(view.proposals), (proposal) =>
        h.keyed('article')(proposal.id, styled(h, s.panel()), [
          h.header(styled(h, s.sectionHead()), [
            Ui.chip(h, format(language, 'job.version', { version: proposal.version })),
            view.changesRequested.includes(proposal.version)
              ? Ui.chip(h, say(language, 'job.changeRequested'), 'seal')
              : h.empty,
          ]),
          ...versionBody(h, language, proposal),
        ]),
      ),
    ],
  )

/** The agreement: the exact version the buyer accepted. */
export const agreementView = (h: Html.HtmlBuilder<Message>, language: Language, agreement: Agreement): Html.Html =>
  h.section(
    [h.AriaLabelledBy('job-agreement'), ...styled(h, s.panel())],
    [
      h.h2([h.Id('job-agreement')], [say(language, 'job.agreement')]),
      h.p(
        [],
        [format(language, 'job.agreementWith', { worker: shortId(agreement.worker), version: agreement.version })],
      ),
      termsView(h, language, agreement.terms),
      h.p(styled(h, s.meta()), [say(language, 'job.digest'), ' ', Ui.dataText(h, agreement.termsDigest)]),
    ],
  )

/** What each side said about the other. */
export const reviewsView = (
  h: Html.HtmlBuilder<Message>,
  language: Language,
  reviews: ReadonlyArray<Review>,
): Html.Html =>
  Array.match(reviews, {
    onEmpty: () => h.empty,
    onNonEmpty: (given) =>
      h.section(
        [h.AriaLabelledBy('job-reviews'), ...styled(h, s.section())],
        [
          h.h2([h.Id('job-reviews')], [say(language, 'job.reviews')]),
          h.ul(
            styled(h, s.rows()),
            Array.map(given, (review) =>
              h.keyed('li')(review.author, styled(h, s.row()), [
                h.p(styled(h, s.rowTitle()), [
                  format(language, 'job.reviewBy', { author: shortId(review.author), rating: review.rating }),
                ]),
                review.comment === undefined ? h.empty : h.p([], [review.comment]),
              ]),
            ),
          ),
        ],
      ),
  })
