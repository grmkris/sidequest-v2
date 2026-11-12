import { format } from '@sidequest/i18n'
import type {
  AccountId,
  BidderJobView,
  BuyerJobView,
  JobStage,
  PublicJobView,
  Review as ReviewRecord,
  WorkerFee,
  WorkRequest,
} from '@sidequest/protocol'
import { Array, Option } from 'effect'
import { AsyncData, type Html, Submodel } from 'foldkit'
import { formatAmount } from '../../Amount.ts'
import type { Language } from '../../Language.ts'
import { nameOf } from '../../Names.ts'
import { AppRoute, signInHref } from '../../route.ts'
import { Session } from '../../Session.ts'
import { styled } from '../../Styled.ts'
import { formatInstant, type PlainKey, say } from '../../Text.ts'
import * as Ui from '../../Ui.ts'
import * as s from '../../Ui.styles.ts'
import { byAudience, Decision, Message, type Model } from './Job.ts'
import * as js from './Job.styles.ts'
import * as Propose from './Propose.ts'
import { agreementView, bidderProposals, buyerProposals, type Reader, reviewsView } from './ProposalsView.ts'
import * as Review from './Review.ts'
import * as RoomView from './RoomView.ts'
import * as SettlementView from './SettlementView.ts'

type ViewInputs = { readonly session: Session; readonly me: Option.Option<AccountId>; readonly timeZone: string }

const stageKeys: Readonly<Record<JobStage, PlainKey>> = {
  Unposted: 'job.state.unposted',
  Open: 'job.state.open',
  Awarded: 'job.state.awarded',
  Funded: 'job.state.funded',
  Delivered: 'job.state.delivered',
  Disputed: 'job.state.disputed',
  Settled: 'job.state.settled',
  Cancelled: 'job.state.cancelled',
  Expired: 'job.state.expired',
}

const stageChip = (h: Html.HtmlBuilder<Message>, language: Language, stage: JobStage) =>
  Ui.chip(
    h,
    say(language, stageKeys[stage]),
    stage === 'Settled' || stage === 'Funded' ? 'done' : stage === 'Disputed' ? 'danger' : 'neutral',
  )

const requestPanel = (h: Html.HtmlBuilder<Message>, reader: Reader, request: WorkRequest, stage: JobStage) => {
  const language = reader.language
  return h.section(
    [h.AriaLabel(say(language, 'job.request')), ...styled(h, s.panel())],
    [
      h.p(styled(h, js.description()), [request.description]),
      Ui.facts(h, [
        Ui.fact(h, say(language, 'job.stage'), stageChip(h, language, stage)),
        Ui.fact(h, say(language, 'job.openUntil'), formatInstant(request.expiresAt, language, reader.timeZone)),
        Ui.fact(h, say(language, 'job.buyer'), nameOf(reader.names, request.buyer, language)),
      ]),
    ],
  )
}

const proposeSection = (h: Html.HtmlBuilder<Message>, model: Model, session: Session) =>
  Option.match(model.maybePropose, {
    onNone: () => h.empty,
    onSome: (propose) =>
      h.section(
        [h.AriaLabelledBy('job-propose'), ...styled(h, s.panel())],
        [
          h.h2(
            [h.Id('job-propose')],
            [
              Option.isSome(propose.maybePrevious)
                ? say(model.language, 'job.revise')
                : say(model.language, 'job.propose'),
            ],
          ),
          Session.guards.SignedIn(session)
            ? h.submodel({
                slotId: 'propose',
                model: propose,
                view: Propose.view,
                toParentMessage: (message) => Message.GotProposeMessage({ message }),
              })
            : h.p(
                [],
                [
                  h.a(
                    [h.Href(signInHref(AppRoute.Job({ job: model.job })))],
                    [say(model.language, 'job.signInToPropose')],
                  ),
                ],
              ),
        ],
      ),
  })

const settlementSection = (h: Html.HtmlBuilder<Message>, model: Model, timeZone: string) =>
  Option.match(model.maybeSettlement, {
    onNone: () => h.empty,
    onSome: (settlement) =>
      h.submodel({
        slotId: 'settlement',
        model: settlement,
        view: SettlementView.view,
        viewInputs: { timeZone },
        toParentMessage: (message) => Message.GotSettlementMessage({ message }),
      }),
  })

const reviewSection = (h: Html.HtmlBuilder<Message>, model: Model, show: boolean) =>
  show
    ? h.submodel({
        slotId: 'review',
        model: model.review,
        view: Review.view,
        toParentMessage: (message) => Message.GotReviewMessage({ message }),
      })
    : h.empty

const decisionProblem = (h: Html.HtmlBuilder<Message>, model: Model) =>
  Decision.guards.Failed(model.decision) ? Ui.problemNotice(h, model.language, model.decision.problem) : h.empty

const cancelControls = (h: Html.HtmlBuilder<Message>, model: Model) =>
  Decision.match(model.decision, {
    ConfirmingCancel: () =>
      Ui.notice(h, 'neutral', [
        h.p([], [say(model.language, 'job.cancelConfirm')]),
        h.div(styled(h, s.actions()), [
          Ui.button(h, {
            label: say(model.language, 'job.cancel'),
            onClick: Message.ClickedConfirmCancel(),
            kind: 'destructive',
          }),
          Ui.button(h, { label: say(model.language, 'job.keep'), onClick: Message.ClickedKeep() }),
        ]),
      ]),
    Cancelling: () =>
      Ui.button(h, { label: say(model.language, 'job.cancelling'), onClick: Message.ClickedKeep(), busy: true }),
    Idle: () =>
      Ui.button(h, {
        label: say(model.language, 'job.cancel'),
        onClick: Message.ClickedCancelRequest(),
        kind: 'destructive',
      }),
    ConfirmingAccept: () => h.empty,
    Accepting: () => h.empty,
    RequestingChange: () => h.empty,
    Failed: () => h.empty,
  })

const reviewedBy = (reviews: ReadonlyArray<ReviewRecord>, account: Option.Option<AccountId>) =>
  Array.some(reviews, (review) => Option.contains(account, review.author))

const buyerView = (
  h: Html.HtmlBuilder<Message>,
  model: Model,
  reader: Reader,
  buyer: BuyerJobView,
  me: Option.Option<AccountId>,
) => [
  ...(buyer.request === null ? [] : [requestPanel(h, reader, buyer.request, buyer.state)]),
  buyer.agreement === null
    ? buyerProposals(h, reader, buyer, model.decision)
    : agreementView(h, reader, buyer.agreement),
  decisionProblem(h, model),
  settlementSection(h, model, reader.timeZone),
  reviewSection(h, model, buyer.state === 'Settled' && !reviewedBy(buyer.reviews, me)),
  reviewsView(h, reader, buyer.reviews),
  buyer.state === 'Open' ? h.div(styled(h, s.actions()), [cancelControls(h, model)]) : h.empty,
]

const percentOf = (bps: number): string => `${bps / 100}%`

/** What the escrow keeps from the worker's pay, and what reaches them, on the version they won. */
const feeNotice = (h: Html.HtmlBuilder<Message>, language: Language, bidder: BidderJobView, fee: WorkerFee) =>
  Option.match(Array.last(bidder.proposals), {
    onNone: () => h.empty,
    onSome: ({ terms }) =>
      Ui.notice(h, 'neutral', [
        h.p(
          [],
          [
            format(language, 'job.fee', {
              percent: percentOf(fee.bps),
              amount: formatAmount(terms.amount, terms.asset, language),
              fee: formatAmount(fee.amount, terms.asset, language),
              worker: formatAmount((BigInt(terms.amount) - BigInt(fee.amount)).toString(), terms.asset, language),
            }),
          ],
        ),
      ]),
  })

/** For the worker of a settled job: whether the buyer reviewed them, and whether they reviewed the buyer. */
const reviewState = (h: Html.HtmlBuilder<Message>, language: Language, bidder: BidderJobView) =>
  h.ul(styled(h, s.rows()), [
    h.li(styled(h, s.row()), [
      say(
        language,
        reviewedBy(bidder.reviews, Option.fromNullishOr(bidder.request?.buyer))
          ? 'job.buyerReviewed'
          : 'job.buyerNotReviewed',
      ),
    ]),
    reviewedBy(bidder.reviews, Option.fromNullishOr(bidder.bidder))
      ? h.li(styled(h, s.row()), [say(language, 'job.youReviewed')])
      : h.empty,
  ])

const bidderView = (
  h: Html.HtmlBuilder<Message>,
  model: Model,
  reader: Reader,
  bidder: BidderJobView,
  session: Session,
) => {
  const worker = bidder.outcome === 'won'
  const settled = worker && bidder.state === 'Settled'
  return [
    ...(bidder.request === null ? [] : [requestPanel(h, reader, bidder.request, bidder.state)]),
    bidderProposals(h, reader, bidder),
    worker && bidder.fee !== null ? feeNotice(h, reader.language, bidder, bidder.fee) : h.empty,
    proposeSection(h, model, session),
    settlementSection(h, model, reader.timeZone),
    settled ? reviewState(h, reader.language, bidder) : h.empty,
    reviewSection(h, model, settled && !reviewedBy(bidder.reviews, Option.fromNullishOr(bidder.bidder))),
    reviewsView(h, reader, bidder.reviews),
  ]
}

const publicView = (
  h: Html.HtmlBuilder<Message>,
  model: Model,
  reader: Reader,
  anyone: PublicJobView,
  session: Session,
) => [
  ...(anyone.request === null ? [] : [requestPanel(h, reader, anyone.request, anyone.state)]),
  proposeSection(h, model, session),
]

const titleOf = (model: Model): string =>
  Option.match(AsyncData.getData(model.view), {
    onNone: () => say(model.language, 'job.loading'),
    onSome: (view) =>
      byAudience(view, {
        buyer: (buyer) => buyer.request?.title ?? say(model.language, 'job.untitled'),
        bidder: (bidder) =>
          bidder.request?.title ??
          Option.match(Array.last(bidder.proposals), {
            onNone: () => say(model.language, 'job.untitled'),
            onSome: (proposal) => format(model.language, 'job.bidderTitle', { title: proposal.terms.title }),
          }),
        public: (anyone) => anyone.request?.title ?? say(model.language, 'job.untitled'),
      }),
  })

/** The page's title, for the document. */
export const documentTitle = titleOf

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, { session, me, timeZone }, h) => {
  const reader: Reader = { language: model.language, timeZone, names: model.names }
  return AsyncData.matchData(model.view, {
    onEmpty: () => h.div(styled(h, s.page()), [Ui.pageHead(h, say(model.language, 'job.loading'))]),
    onFailure: (problem) =>
      h.div(styled(h, s.page()), [
        Ui.pageHead(h, say(model.language, 'job.unavailable')),
        Ui.problemNotice(h, model.language, problem),
      ]),
    onData: (jobView) =>
      h.div(styled(h, s.page()), [
        Ui.pageHead(h, titleOf(model)),
        h.div(styled(h, js.layout()), [
          h.div(
            styled(h, js.main()),
            byAudience(jobView, {
              buyer: (buyer) => buyerView(h, model, reader, buyer, me),
              bidder: (bidder) => bidderView(h, model, reader, bidder, session),
              public: (anyone) => publicView(h, model, reader, anyone, session),
            }),
          ),
          h.div(styled(h, js.aside()), [
            h.submodel({
              slotId: 'room',
              model: model.room,
              view: RoomView.view,
              viewInputs: { me, names: model.names },
              toParentMessage: (message) => Message.GotRoomMessage({ message }),
            }),
          ]),
        ]),
      ]),
  })
})
