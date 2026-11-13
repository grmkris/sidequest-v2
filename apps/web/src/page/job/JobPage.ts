import { format } from '@sidequest/i18n'
import type { AcceptView, JobView, ProposalView, Stage, StatementView } from '@sidequest/fold'
import { Array, Option } from 'effect'
import { AsyncData, type Html, Submodel } from 'foldkit'
import { formatAmount } from '../../Amount.ts'
import { signerOnly } from '../../Gate.ts'
import type { Language } from '../../Language.ts'
import { nameOf } from '../../Names.ts'
import { publishFailureNotice } from '../../Publishing.ts'
import { AppRoute, identityHref } from '../../route.ts'
import { styled } from '../../Styled.ts'
import { formatInstant, type PlainKey, say } from '../../Text.ts'
import * as Ui from '../../Ui.ts'
import * as s from '../../Ui.styles.ts'
import { walletOn } from '../../Me.ts'
import { chainSection } from './ChainView.ts'
import {
  type Act,
  Action,
  isBuyer,
  isMine,
  Message,
  type Model,
  negotiable,
  payToOf,
  reviewSubject,
  standing,
} from './Job.ts'
import * as js from './Job.styles.ts'
import { addressOf, settledFlow } from './money/message.ts'
import * as MoneyView from './money/view.ts'
import { panelShown } from './money/view.ts'
import * as Propose from './Propose.ts'
import * as Review from './Review.ts'
import { reviewsSection } from './ReviewsView.ts'
import { termsView } from './TermsView.ts'

// The job as its signed events and the chain's facts fold it: the request, every proposal with its labels, the
// accepts and statements, and the escrow's progress. Who looks decides what they may do: the buyer accepts or closes,
// a bidder proposes, revises or withdraws. Accepting is a signal: the copy never says a deal binds before funding.

type ViewInputs = { readonly timeZone: string }

type Reader = { readonly model: Model; readonly view: JobView; readonly language: Language; readonly timeZone: string }

const stageKeys: Readonly<Record<Stage, PlainKey>> = {
  open: 'job.stage.open',
  proposed: 'job.stage.proposed',
  accepted: 'job.stage.accepted',
  closed: 'job.stage.closed',
  funded: 'job.stage.funded',
  delivered: 'job.stage.delivered',
  rejected: 'job.stage.rejected',
  released: 'job.stage.released',
  ruled: 'job.stage.ruled',
  refunded: 'job.stage.refunded',
  reclaimed: 'job.stage.reclaimed',
}

const stageChip = (h: Html.HtmlBuilder<Message>, language: Language, stage: Stage) =>
  Ui.chip(
    h,
    say(language, stageKeys[stage]),
    stage === 'released' || stage === 'funded' ? 'done' : stage === 'rejected' ? 'danger' : 'neutral',
  )

const jobRoute = (model: Model) => AppRoute.Job({ job: model.job })

const requestPanel = (h: Html.HtmlBuilder<Message>, { model, view, language, timeZone }: Reader) =>
  h.section(
    [h.AriaLabel(say(language, 'job.request')), ...styled(h, s.panel())],
    [
      h.p(styled(h, js.description()), [view.request.content.description]),
      Ui.facts(h, [
        Ui.fact(h, say(language, 'job.stageLabel'), stageChip(h, language, view.stage)),
        Ui.fact(
          h,
          say(language, 'job.openUntil'),
          view.request.expired
            ? h.span(
                [],
                [
                  formatInstant(view.request.content.expiresAt, language, timeZone),
                  ' ',
                  Ui.chip(h, say(language, 'job.expired')),
                ],
              )
            : formatInstant(view.request.content.expiresAt, language, timeZone),
        ),
        Ui.fact(h, say(language, 'job.buyer'), h.span([h.Title(view.buyer)], [nameOf(model.names, view.buyer)])),
      ]),
      view.request.closedByBuyer ? Ui.notice(h, 'neutral', [h.p([], [say(language, 'job.closedNote')])]) : h.empty,
    ],
  )

const publishedKeys: Readonly<Record<Act, PlainKey>> = {
  proposal: 'job.published.proposal',
  accept: 'job.published.accept',
  withdraw: 'job.published.withdraw',
  close: 'job.published.close',
  review: 'job.published.review',
}

const actionNotice = (h: Html.HtmlBuilder<Message>, model: Model, language: Language) =>
  Action.match(model.action, {
    Idle: () => h.empty,
    ConfirmingAccept: () => h.empty,
    ConfirmingClose: () => h.empty,
    Publishing: () => Ui.waiting(h, say(language, 'job.publishing')),
    Published: ({ act }) => Ui.notice(h, 'done', [h.p([], [say(language, publishedKeys[act])])]),
    Failed: ({ failure }) => publishFailureNotice(h, language, failure, identityHref(jobRoute(model))),
  })

/** The fold's labels of a proposal, in the order they are shown. */
type ProposalLabel = 'superseded' | 'withdrawn' | 'expired' | 'accepted' | 'funded' | 'otherBuyer'

const labelKeys: ReadonlyArray<readonly [ProposalLabel, PlainKey]> = [
  ['superseded', 'job.label.superseded'],
  ['withdrawn', 'job.label.withdrawn'],
  ['expired', 'job.label.expired'],
  ['accepted', 'job.label.accepted'],
  ['funded', 'job.label.funded'],
  ['otherBuyer', 'job.label.otherBuyer'],
]

const proposalLabels = (h: Html.HtmlBuilder<Message>, language: Language, proposal: ProposalView) =>
  h.ul(
    [h.AriaLabel(say(language, 'job.labels')), ...styled(h, js.labels())],
    Array.map(
      Array.filter(labelKeys, ([field]) => proposal[field]),
      ([field, key]) =>
        h.keyed('li')(
          field,
          [],
          [Ui.chip(h, say(language, key), field === 'accepted' || field === 'funded' ? 'done' : 'neutral')],
        ),
    ),
  )

const confirmAccept = (h: Html.HtmlBuilder<Message>, { model, language, timeZone }: Reader, proposal: ProposalView) =>
  h.div(
    [h.Role('group'), h.AriaLabel(say(language, 'job.confirmAcceptLabel')), ...styled(h, js.slip())],
    [
      h.p(
        [],
        [
          format(language, 'job.confirmAccept', {
            bidder: nameOf(model.names, proposal.author),
            amount: formatAmount(proposal.content.terms.amount, proposal.content.terms.asset, language),
            deadline: formatInstant(proposal.content.terms.deliveryDeadline, language, timeZone),
          }),
        ],
      ),
      h.div(styled(h, s.actions()), [
        Ui.button(h, { label: say(language, 'job.accept'), onClick: Message.ClickedConfirmAccept(), kind: 'primary' }),
        Ui.button(h, { label: say(language, 'common.cancel'), onClick: Message.ClickedKeep() }),
      ]),
    ],
  )

/** The buyer may fund any proposal that stands, accepted or not, from the wallet linked to their key. */
const fundButton = (h: Html.HtmlBuilder<Message>, { model, language }: Reader, proposal: ProposalView) =>
  Option.match(Option.flatMap(walletOn(model.me, proposal.content.terms.network), addressOf), {
    onNone: () => h.empty,
    onSome: (payer) =>
      Ui.button(h, {
        label: say(language, 'job.fund'),
        onClick: Message.ClickedFund({ proposal: proposal.id, payer }),
        disabled: !settledFlow(model.money.flow),
      }),
  })

const proposalActions = (h: Html.HtmlBuilder<Message>, reader: Reader, proposal: ProposalView) => {
  const { model, view, language } = reader
  if (!negotiable(view) || !standing(proposal)) {
    return h.empty
  }
  const busy = Action.guards.Publishing(model.action)
  if (isBuyer(model, view)) {
    if (Action.guards.ConfirmingAccept(model.action) && model.action.proposal === proposal.id) {
      return confirmAccept(h, reader, proposal)
    }
    return proposal.accepted
      ? h.empty
      : h.div(styled(h, s.actions()), [
          Ui.button(h, {
            label: say(language, 'job.accept'),
            onClick: Message.ClickedAccept({ proposal: proposal.id }),
            kind: 'primary',
            busy,
          }),
          fundButton(h, reader, proposal),
        ])
  }
  return isMine(model, proposal.author)
    ? h.div(styled(h, s.actions()), [
        Ui.button(h, { label: say(language, 'job.revise'), onClick: Message.ClickedRevise({ proposal: proposal.id }) }),
        Ui.button(h, {
          label: say(language, 'job.withdraw'),
          onClick: Message.ClickedWithdraw({ proposal: proposal.id }),
          kind: 'destructive',
          busy,
        }),
      ])
    : h.empty
}

const proposalCard = (h: Html.HtmlBuilder<Message>, reader: Reader, proposal: ProposalView) => {
  const { model, language, timeZone } = reader
  return h.keyed('article')(proposal.id, styled(h, s.panel()), [
    h.header(styled(h, s.sectionHead()), [
      h.h3([], [format(language, 'job.fromBidder', { bidder: nameOf(model.names, proposal.author) })]),
      proposalLabels(h, language, proposal),
    ]),
    h.h4(styled(h, js.versionTitle()), [proposal.content.terms.title]),
    termsView(h, language, timeZone, proposal.content.terms),
    h.p(styled(h, s.meta()), [
      format(language, 'job.validUntil', { date: formatInstant(proposal.content.validUntil, language, timeZone) }),
    ]),
    h.p(styled(h, s.meta()), [say(language, 'job.payTo'), ' ', Ui.dataText(h, proposal.content.payTo)]),
    h.p(styled(h, s.meta()), [say(language, 'job.digest'), ' ', Ui.dataText(h, proposal.content.termsDigest)]),
    proposalActions(h, reader, proposal),
  ])
}

const proposalsSection = (h: Html.HtmlBuilder<Message>, reader: Reader) => {
  const language = reader.language
  return h.section(
    [h.AriaLabelledBy('job-proposals'), ...styled(h, s.section())],
    [
      h.h2([h.Id('job-proposals')], [say(language, 'job.proposals')]),
      Array.match(reader.view.proposals, {
        onEmpty: () => h.p(styled(h, s.meta()), [say(language, 'job.noProposals')]),
        onNonEmpty: (proposals) =>
          h.div(
            styled(h, s.section()),
            Array.map(Array.reverse(proposals), (proposal) => proposalCard(h, reader, proposal)),
          ),
      }),
    ],
  )
}

/** Where a bidder makes a proposal: with a signer and a linked wallet, the form; otherwise what they need first. */
const proposeSection = (h: Html.HtmlBuilder<Message>, reader: Reader) => {
  const { model, view, language } = reader
  if (!negotiable(view) || view.request.closedByBuyer || isBuyer(model, view)) {
    return h.empty
  }
  const route = jobRoute(model)
  return h.section(
    [h.AriaLabelledBy('job-propose'), ...styled(h, s.panel())],
    [
      h.h2(
        [h.Id('job-propose')],
        [
          say(
            language,
            Option.exists(model.maybePropose, (propose) => Option.isSome(propose.maybePrevious))
              ? 'job.reviseTitle'
              : 'job.propose',
          ),
        ],
      ),
      signerOnly(h, { language, me: model.me, route }, () =>
        Option.match(payToOf(model), {
          onNone: () =>
            Ui.notice(h, 'neutral', [
              h.p([], [say(language, 'job.needsWallet')]),
              h.p([], [h.a([h.Href(identityHref(route))], [say(language, 'job.linkWallet')])]),
            ]),
          onSome: (payTo) =>
            Option.match(model.maybePropose, {
              onNone: () =>
                h.div(styled(h, s.actions()), [
                  Ui.button(h, {
                    label: say(language, 'job.propose'),
                    onClick: Message.ClickedPropose(),
                    kind: 'primary',
                  }),
                ]),
              onSome: (propose) =>
                h.div(styled(h, s.section()), [
                  h.p(styled(h, s.meta()), [say(language, 'job.paidTo'), ' ', Ui.dataText(h, payTo)]),
                  h.submodel({
                    slotId: 'propose',
                    model: propose,
                    view: Propose.view,
                    toParentMessage: (message) => Message.GotProposeMessage({ message }),
                  }),
                  h.div(styled(h, s.actions()), [
                    Ui.button(h, { label: say(language, 'common.cancel'), onClick: Message.ClickedCancelPropose() }),
                  ]),
                ]),
            }),
        }),
      ),
    ],
  )
}

const acceptRow = (h: Html.HtmlBuilder<Message>, { model, language, timeZone }: Reader, accept: AcceptView) =>
  h.keyed('li')(accept.id, styled(h, s.row()), [
    h.p(
      [],
      [
        format(language, 'job.acceptedBy', {
          author: nameOf(model.names, accept.author),
          worker: nameOf(model.names, accept.worker),
          date: formatInstant(accept.createdAt, language, timeZone),
        }),
      ],
    ),
    h.div(styled(h, js.labels()), [
      accept.fromBuyer ? h.empty : Ui.chip(h, say(language, 'job.acceptLabel.notBuyer'), 'danger'),
      accept.matchesProposal ? h.empty : Ui.chip(h, say(language, 'job.acceptLabel.noMatch'), 'danger'),
      accept.conflicting ? Ui.chip(h, say(language, 'job.acceptLabel.conflicting')) : h.empty,
    ]),
  ])

const statementKeys: Readonly<Record<StatementView['content']['type'], PlainKey>> = {
  withdraw_request: 'job.statement.withdrawRequest',
  withdraw_proposal: 'job.statement.withdrawProposal',
  rejection_reason: 'job.statement.rejectionReason',
}

const statementRow = (h: Html.HtmlBuilder<Message>, { model, language }: Reader, statement: StatementView) =>
  h.keyed('li')(statement.id, styled(h, s.row()), [
    h.p(styled(h, s.rowTitle()), [
      format(language, 'job.statementBy', { author: nameOf(model.names, statement.author) }),
      ' ',
      Ui.chip(h, say(language, statementKeys[statement.content.type])),
      statement.effective ? h.empty : Ui.chip(h, say(language, 'job.statement.notEffective'), 'danger'),
    ]),
    h.p(styled(h, js.description()), [statement.content.text]),
  ])

/** The accepts and the statements: what was said about the job, on the record. */
const recordSection = (h: Html.HtmlBuilder<Message>, reader: Reader) =>
  Array.isReadonlyArrayEmpty(reader.view.accepts) && Array.isReadonlyArrayEmpty(reader.view.statements)
    ? h.empty
    : h.section(
        [h.AriaLabelledBy('job-record'), ...styled(h, s.section())],
        [
          h.h2([h.Id('job-record')], [say(reader.language, 'job.record')]),
          h.p(styled(h, s.meta()), [say(reader.language, 'job.recordNote')]),
          h.ul(styled(h, s.rows()), [
            ...Array.map(reader.view.accepts, (accept) => acceptRow(h, reader, accept)),
            ...Array.map(reader.view.statements, (statement) => statementRow(h, reader, statement)),
          ]),
        ],
      )

/** The money panel, for the job's parties. */
const moneySection = (h: Html.HtmlBuilder<Message>, { model, view, timeZone }: Reader) =>
  panelShown(model.money, view, model.me)
    ? signerOnly(h, { language: model.language, me: model.me, route: jobRoute(model) }, () =>
        h.submodel({
          slotId: 'money',
          model: model.money,
          view: MoneyView.view,
          viewInputs: {
            job: view,
            me: model.me,
            names: model.names,
            timeZone,
            identityHref: identityHref(jobRoute(model)),
          },
          toParentMessage: (message) => Message.GotMoneyMessage({ message }),
        }),
      )
    : h.empty

/** The person's review form, once the job settled, when the fold would count their review: they are its buyer or its
 * worker, and the escrow's wallet on their side is linked to their key. */
const reviewForm = (h: Html.HtmlBuilder<Message>, { model, view }: Reader): Option.Option<Html.Html> => {
  const funding = view.funding
  const linked =
    funding !== null &&
    ((isBuyer(model, view) && funding.payerLinked) ||
      (view.worker !== null && isMine(model, view.worker) && funding.receiverLinked))
  return view.ending !== null && linked && Option.isSome(reviewSubject(model, view))
    ? Option.some(
        h.submodel({
          slotId: 'review',
          model: model.review,
          view: Review.view,
          toParentMessage: (message) => Message.GotReviewMessage({ message }),
        }),
      )
    : Option.none()
}

const closeControls = (h: Html.HtmlBuilder<Message>, { model, view, language }: Reader) => {
  if (!isBuyer(model, view) || !negotiable(view) || view.request.closedByBuyer) {
    return h.empty
  }
  return Action.guards.ConfirmingClose(model.action)
    ? Ui.notice(h, 'neutral', [
        h.p([], [say(language, 'job.closeConfirm')]),
        h.div(styled(h, s.actions()), [
          Ui.button(h, {
            label: say(language, 'job.close'),
            onClick: Message.ClickedConfirmClose(),
            kind: 'destructive',
          }),
          Ui.button(h, { label: say(language, 'job.keep'), onClick: Message.ClickedKeep() }),
        ]),
      ])
    : h.div(styled(h, s.actions()), [
        Ui.button(h, {
          label: say(language, 'job.close'),
          onClick: Message.ClickedClose(),
          kind: 'destructive',
          busy: Action.guards.Publishing(model.action) && model.action.act === 'close',
        }),
      ])
}

/** The page's title, for the document. */
export const documentTitle = (model: Model): string =>
  Option.match(AsyncData.getData(model.view), {
    onNone: () => say(model.language, 'job.loading'),
    onSome: (view) => view.request.content.title,
  })

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, { timeZone }, h) =>
  AsyncData.matchData(model.view, {
    onEmpty: () => h.div(styled(h, s.page()), [Ui.pageHead(h, say(model.language, 'job.loading'))]),
    onFailure: (problem) =>
      h.div(styled(h, s.page()), [
        Ui.pageHead(h, say(model.language, 'job.unavailable')),
        Ui.problemNotice(h, model.language, problem),
      ]),
    onData: (jobView) => {
      const reader: Reader = { model, view: jobView, language: model.language, timeZone }
      return h.div(styled(h, s.page()), [
        Ui.pageHead(h, jobView.request.content.title),
        h.div(styled(h, js.main()), [
          requestPanel(h, reader),
          actionNotice(h, model, model.language),
          moneySection(h, reader),
          chainSection(h, {
            view: jobView,
            maybePayment: model.money.maybePayment,
            language: model.language,
            timeZone,
          }),
          proposalsSection(h, reader),
          proposeSection(h, reader),
          recordSection(h, reader),
          reviewsSection(h, {
            view: jobView,
            language: model.language,
            names: model.names,
            maybeForm: reviewForm(h, reader),
          }),
          closeControls(h, reader),
        ]),
      ])
    },
  }),
)
