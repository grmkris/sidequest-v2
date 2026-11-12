import { format } from '@sidequest/i18n'
import type { AccountId, BidderJobView, BuyerJobView, JobStage, PublicJobView, WorkRequest } from '@sidequest/protocol'
import { Array, Option } from 'effect'
import { AsyncData, type Html, Submodel } from 'foldkit'
import type { Language } from '../../Language.ts'
import { AppRoute, signInHref } from '../../route.ts'
import { Session } from '../../Session.ts'
import { styled } from '../../Styled.ts'
import { formatInstant, type PlainKey, say, shortId } from '../../Text.ts'
import * as Ui from '../../Ui.ts'
import * as s from '../../Ui.styles.ts'
import { byAudience, Decision, Message, type Model } from './Job.ts'
import * as js from './Job.styles.ts'
import * as Propose from './Propose.ts'
import { agreementView, bidderProposals, buyerProposals, reviewsView } from './ProposalsView.ts'
import * as Review from './Review.ts'
import * as RoomView from './RoomView.ts'
import * as SettlementView from './SettlementView.ts'

type ViewInputs = { readonly session: Session; readonly me: Option.Option<AccountId> }

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

const requestPanel = (h: Html.HtmlBuilder<Message>, language: Language, request: WorkRequest, stage: JobStage) =>
  h.section(
    [h.AriaLabel(say(language, 'job.request')), ...styled(h, s.panel())],
    [
      h.p(styled(h, js.description()), [request.description]),
      Ui.facts(h, [
        Ui.fact(h, say(language, 'job.stage'), stageChip(h, language, stage)),
        Ui.fact(h, say(language, 'job.openUntil'), formatInstant(request.expiresAt, language)),
        Ui.fact(h, say(language, 'job.buyer'), format(language, 'common.account', { id: shortId(request.buyer) })),
      ]),
    ],
  )

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

const settlementSection = (h: Html.HtmlBuilder<Message>, model: Model) =>
  Option.match(model.maybeSettlement, {
    onNone: () => h.empty,
    onSome: (settlement) =>
      h.submodel({
        slotId: 'settlement',
        model: settlement,
        view: SettlementView.view,
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

const settledFor = (model: Model): boolean =>
  Option.exists(model.maybeSettlement, (settlement) =>
    Option.exists(AsyncData.getData(settlement.status), (status) => status.stage === 'Settled'),
  )

const reviewedBy = (buyer: BuyerJobView, me: Option.Option<AccountId>) =>
  Array.some(buyer.reviews, (review) => Option.contains(me, review.author))

const buyerView = (h: Html.HtmlBuilder<Message>, model: Model, buyer: BuyerJobView, me: Option.Option<AccountId>) => [
  ...(buyer.request === null ? [] : [requestPanel(h, model.language, buyer.request, buyer.state)]),
  buyer.agreement === null
    ? buyerProposals(h, model.language, buyer, model.decision)
    : agreementView(h, model.language, buyer.agreement),
  decisionProblem(h, model),
  settlementSection(h, model),
  reviewSection(h, model, buyer.state === 'Settled' && !reviewedBy(buyer, me)),
  reviewsView(h, model.language, buyer.reviews),
  buyer.state === 'Open' ? h.div(styled(h, s.actions()), [cancelControls(h, model)]) : h.empty,
]

const bidderView = (h: Html.HtmlBuilder<Message>, model: Model, bidder: BidderJobView, session: Session) => [
  bidderProposals(h, model.language, bidder),
  proposeSection(h, model, session),
  settlementSection(h, model),
  reviewSection(h, model, settledFor(model)),
]

const publicView = (h: Html.HtmlBuilder<Message>, model: Model, anyone: PublicJobView, session: Session) => [
  ...(anyone.request === null ? [] : [requestPanel(h, model.language, anyone.request, anyone.state)]),
  proposeSection(h, model, session),
]

const titleOf = (model: Model): string =>
  Option.match(AsyncData.getData(model.view), {
    onNone: () => say(model.language, 'job.loading'),
    onSome: (view) =>
      byAudience(view, {
        buyer: (buyer) => buyer.request?.title ?? say(model.language, 'job.untitled'),
        bidder: (bidder) =>
          Option.match(Array.last(bidder.proposals), {
            onNone: () => say(model.language, 'job.untitled'),
            onSome: (proposal) => format(model.language, 'job.bidderTitle', { title: proposal.terms.title }),
          }),
        public: (anyone) => anyone.request?.title ?? say(model.language, 'job.untitled'),
      }),
  })

/** The page's title, for the document. */
export const documentTitle = titleOf

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, { session, me }, h) =>
  AsyncData.matchData(model.view, {
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
              buyer: (buyer) => buyerView(h, model, buyer, me),
              bidder: (bidder) => bidderView(h, model, bidder, session),
              public: (anyone) => publicView(h, model, anyone, session),
            }),
          ),
          h.div(styled(h, js.aside()), [
            h.submodel({
              slotId: 'room',
              model: model.room,
              view: RoomView.view,
              viewInputs: { me },
              toParentMessage: (message) => Message.GotRoomMessage({ message }),
            }),
          ]),
        ]),
      ]),
  }),
)
