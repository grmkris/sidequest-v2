import { format } from '@sidequest/i18n'
import type { ChainOutcome, EscrowStatus, Receipt } from '@sidequest/protocol'
import { Array, Option } from 'effect'
import { AsyncData, type Html, Submodel } from 'foldkit'
import { formatAmount } from '../../Amount.ts'
import { FormStatus, shown } from '../../Forms.ts'
import type { Language } from '../../Language.ts'
import { styled } from '../../Styled.ts'
import { formatInstant, type PlainKey, say, shortHex } from '../../Text.ts'
import * as Ui from '../../Ui.ts'
import * as s from '../../Ui.styles.ts'
import { fundingSlip } from './FundingSlip.ts'
import * as js from './Job.styles.ts'
import { Flow, Message, type Model, Poll, type SignKind } from './Settlement.ts'

const kindKeys: Readonly<Record<SignKind, PlainKey>> = {
  fund: 'settlement.kind.fund',
  deliver: 'settlement.kind.deliver',
  approve: 'settlement.kind.approve',
  reject: 'settlement.kind.reject',
}

const outcomeKeys: Readonly<Record<Exclude<ChainOutcome, 'Ruled'>, PlainKey>> = {
  Approved: 'settlement.outcome.approved',
  AcceptedBySilence: 'settlement.outcome.silence',
  Unruled: 'settlement.outcome.unruled',
  Undelivered: 'settlement.outcome.undelivered',
  Reclaimed: 'settlement.outcome.reclaimed',
}

type ReceiptKey = 'settlement.receipt.capture' | 'settlement.receipt.void' | 'settlement.receipt.reclaim'

const receiptKeys: Readonly<Record<Exclude<Receipt['operation'], 'authorize'>, ReceiptKey>> = {
  capture: 'settlement.receipt.capture',
  void: 'settlement.receipt.void',
  reclaim: 'settlement.receipt.reclaim',
}

const progressView = (h: Html.HtmlBuilder<Message>, model: Model, kind: SignKind, step: PlainKey) =>
  Ui.notice(h, 'neutral', [
    h.p([h.AriaBusy(true)], [say(model.language, kindKeys[kind]), ': ', say(model.language, step)]),
  ])

const submittedView = (
  h: Html.HtmlBuilder<Message>,
  model: Model,
  kind: SignKind,
  maybeTransaction: Option.Option<string>,
) =>
  Ui.notice(h, 'neutral', [
    h.p([], [say(model.language, kindKeys[kind]), ': ', say(model.language, 'settlement.sent')]),
    Option.match(maybeTransaction, {
      onNone: () => h.empty,
      onSome: (hash) =>
        h.p(styled(h, s.meta()), [say(model.language, 'settlement.transaction'), ' ', Ui.dataText(h, hash)]),
    }),
    Poll.match(model.poll, {
      Idle: () => h.empty,
      Waiting: () => h.p(styled(h, s.meta()), [say(model.language, 'settlement.checking')]),
      GaveUp: () =>
        h.div(styled(h, s.section()), [
          h.p([], [say(model.language, 'settlement.notYet')]),
          Ui.button(h, { label: say(model.language, 'settlement.checkAgain'), onClick: Message.ClickedCheckAgain() }),
        ]),
    }),
  ])

/** A step in flight, if one is: it shows whatever the escrow's stage. */
const inFlight = (h: Html.HtmlBuilder<Message>, model: Model): Option.Option<Html.Html> =>
  Flow.match(model.flow, {
    Idle: () => Option.none(),
    PreparingFunding: () => Option.some(progressView(h, model, 'fund', 'settlement.step.preparing')),
    ReviewingFunding: ({ request }) => Option.some(fundingSlip(h, model.language, request)),
    EditingDelivery: () => Option.none(),
    RecordingDelivery: () => Option.some(progressView(h, model, 'deliver', 'settlement.step.recording')),
    ConfirmingApproval: () => Option.none(),
    EditingRejection: () => Option.none(),
    Preparing: ({ kind }) => Option.some(progressView(h, model, kind, 'settlement.step.preparing')),
    Signing: ({ kind }) => Option.some(progressView(h, model, kind, 'settlement.step.signing')),
    Submitting: ({ kind }) => Option.some(progressView(h, model, kind, 'settlement.step.submitting')),
    Submitted: ({ kind, maybeTransaction }) => Option.some(submittedView(h, model, kind, maybeTransaction)),
  })

const fundIntro = (h: Html.HtmlBuilder<Message>, model: Model) =>
  h.div(styled(h, s.section()), [
    h.p([], [say(model.language, 'settlement.fundIntro')]),
    h.div(styled(h, s.actions()), [
      Ui.button(h, {
        label: say(model.language, 'settlement.reviewFunding'),
        onClick: Message.ClickedReviewFunding(),
        kind: 'primary',
      }),
    ]),
  ])

const deliveryForm = (h: Html.HtmlBuilder<Message>, model: Model, url: string, hash: string, status: FormStatus) =>
  h.form(
    [h.OnSubmit(Message.SubmittedDelivery()), h.Novalidate(true), ...styled(h, s.form())],
    [
      h.p([], [say(model.language, 'settlement.deliverIntro')]),
      Ui.textField(h, {
        id: 'delivery-url',
        label: say(model.language, 'settlement.deliveryUrl'),
        hint: say(model.language, 'settlement.deliveryUrlHint'),
        type: 'url',
        inputMode: 'url',
        value: url,
        onInput: (value) => Message.UpdatedDeliveryUrl({ value }),
        error: shown(status, Option.some(say(model.language, 'settlement.deliveryUrlError'))),
        required: true,
      }),
      Ui.textField(h, {
        id: 'delivery-hash',
        label: say(model.language, 'settlement.deliveryHash'),
        hint: say(model.language, 'settlement.deliveryHashHint'),
        value: hash,
        onInput: (value) => Message.UpdatedDeliveryHash({ value }),
        error: shown(status, Option.some(say(model.language, 'settlement.deliveryHashError'))),
        required: true,
      }),
      h.div(styled(h, s.field()), [
        h.label([h.For('delivery-file'), ...styled(h, s.label())], [say(model.language, 'settlement.deliveryFile')]),
        h.input([
          h.Id('delivery-file'),
          h.Type('file'),
          h.OnFileChange((files) => Message.SelectedArtifact({ files })),
        ]),
      ]),
      h.div(styled(h, s.actions()), [
        Ui.submit(h, { label: say(model.language, 'settlement.recordDelivery'), busy: false }),
        Ui.button(h, { label: say(model.language, 'common.cancel'), onClick: Message.ClickedCancel() }),
      ]),
    ],
  )

const workerFunded = (h: Html.HtmlBuilder<Message>, model: Model, status: EscrowStatus) =>
  Flow.guards.EditingDelivery(model.flow)
    ? deliveryForm(h, model, model.flow.url, model.flow.hash, model.flow.status)
    : h.div(styled(h, s.section()), [
        h.p(
          [],
          [
            Option.match(Option.fromNullishOr(status.funding), {
              onNone: () => say(model.language, 'settlement.fundedPlain'),
              onSome: (receipt) =>
                format(model.language, 'settlement.funded', {
                  amount: formatAmount(receipt.amount, receipt.asset, model.language),
                }),
            }),
          ],
        ),
        h.div(styled(h, s.actions()), [
          Ui.button(h, {
            label: say(model.language, 'settlement.deliver'),
            onClick: Message.ClickedDeliver(),
            kind: 'primary',
          }),
        ]),
      ])

const deadlineText = (model: Model) =>
  Option.match(model.setup.maybeTerms, {
    onNone: () => say(model.language, 'settlement.waitingDelivery'),
    onSome: (terms) =>
      format(model.language, 'settlement.waitingDeliveryBy', {
        date: formatInstant(terms.deliveryDeadline, model.language),
      }),
  })

const deliveredFacts = (h: Html.HtmlBuilder<Message>, model: Model, status: EscrowStatus) =>
  Option.match(Option.fromNullishOr(status.delivery), {
    onNone: () => h.empty,
    onSome: (delivery) =>
      Ui.facts(h, [
        Ui.fact(h, say(model.language, 'settlement.deliveredAt'), formatInstant(delivery.deliveredAt, model.language)),
        Ui.fact(h, say(model.language, 'settlement.reviewEnds'), formatInstant(delivery.reviewEndsAt, model.language)),
        Ui.fact(h, say(model.language, 'settlement.deliveryHash'), Ui.dataText(h, delivery.deliveryHash)),
        ...Option.match(model.setup.maybeDeliveryUrl, {
          onNone: () => [],
          onSome: (url) => [
            Ui.fact(
              h,
              say(model.language, 'settlement.deliveryUrl'),
              h.a([h.Href(url), h.Rel('noopener noreferrer'), h.Target('_blank')], [url]),
            ),
          ],
        }),
      ]),
  })

const buyerReview = (h: Html.HtmlBuilder<Message>, model: Model) =>
  Flow.match(model.flow, {
    ConfirmingApproval: () =>
      h.div(styled(h, js.slip()), [
        h.p([], [say(model.language, 'settlement.approveExplain')]),
        h.div(styled(h, s.actions()), [
          Ui.button(h, {
            label: say(model.language, 'settlement.signApproval'),
            onClick: Message.ClickedConfirmApproval(),
            kind: 'seal',
          }),
          Ui.button(h, { label: say(model.language, 'common.cancel'), onClick: Message.ClickedCancel() }),
        ]),
      ]),
    EditingRejection: ({ reason, status }) =>
      h.form(
        [h.OnSubmit(Message.SubmittedRejection()), h.Novalidate(true), ...styled(h, s.form())],
        [
          h.p([], [say(model.language, 'settlement.rejectExplain')]),
          Ui.textArea(h, {
            id: 'rejection-reason',
            label: say(model.language, 'settlement.reason'),
            value: reason,
            onInput: (value) => Message.UpdatedReason({ value }),
            error: shown(status, Option.some(format(model.language, 'form.tooLong', { max: 2000 }))),
            required: true,
          }),
          h.div(styled(h, s.actions()), [
            Ui.submit(h, { label: say(model.language, 'settlement.signRejection'), busy: false, kind: 'destructive' }),
            Ui.button(h, { label: say(model.language, 'common.cancel'), onClick: Message.ClickedCancel() }),
          ]),
        ],
      ),
    Idle: () =>
      h.div(styled(h, s.actions()), [
        Ui.button(h, {
          label: say(model.language, 'settlement.approve'),
          onClick: Message.ClickedApprove(),
          kind: 'primary',
        }),
        Ui.button(h, {
          label: say(model.language, 'settlement.reject'),
          onClick: Message.ClickedReject(),
          kind: 'destructive',
        }),
      ]),
    PreparingFunding: () => h.empty,
    ReviewingFunding: () => h.empty,
    EditingDelivery: () => h.empty,
    RecordingDelivery: () => h.empty,
    Preparing: () => h.empty,
    Signing: () => h.empty,
    Submitting: () => h.empty,
    Submitted: () => h.empty,
  })

const disputeView = (h: Html.HtmlBuilder<Message>, model: Model, status: EscrowStatus) =>
  h.div(styled(h, s.section()), [
    Option.match(Option.fromNullishOr(status.rejection), {
      onNone: () => h.p([], [say(model.language, 'settlement.disputed')]),
      onSome: (rejection) =>
        h.p(
          [],
          [
            format(model.language, 'settlement.disputedOn', {
              rejected: formatInstant(rejection.rejectedAt, model.language),
              ends: formatInstant(rejection.arbitrationEndsAt, model.language),
            }),
          ],
        ),
    }),
    Option.match(model.setup.maybeDisputeReason, {
      onNone: () => h.empty,
      onSome: (reason) => Ui.facts(h, [Ui.fact(h, say(model.language, 'settlement.reason'), reason)]),
    }),
  ])

const receiptRow = (h: Html.HtmlBuilder<Message>, language: Language, receipt: Receipt) =>
  receipt.operation === 'authorize'
    ? h.empty
    : h.keyed('li')(`${receipt.operation}:${receipt.transactionHash}`, styled(h, s.row()), [
        h.p(
          [],
          [
            format(language, receiptKeys[receipt.operation], {
              amount: formatAmount(receipt.amount, receipt.asset, language),
            }),
          ],
        ),
        h.p(styled(h, s.meta()), [
          say(language, 'settlement.transaction'),
          ' ',
          Ui.dataText(h, shortHex(receipt.transactionHash)),
        ]),
      ])

const settledView = (h: Html.HtmlBuilder<Message>, model: Model, status: EscrowStatus) =>
  Option.match(Option.fromNullishOr(status.settlement), {
    onNone: () => h.p([], [say(model.language, 'settlement.settled')]),
    onSome: (settlement) =>
      h.div(styled(h, s.section()), [
        Ui.notice(h, 'done', [
          h.p(
            [],
            [
              settlement.outcome === 'Ruled'
                ? format(model.language, 'settlement.outcome.ruled', { share: `${settlement.workerShareBps / 100}%` })
                : say(model.language, outcomeKeys[settlement.outcome]),
            ],
          ),
        ]),
        h.ul(
          [h.AriaLabel(say(model.language, 'settlement.receipts')), ...styled(h, s.rows())],
          Array.map(settlement.receipts, (receipt) => receiptRow(h, model.language, receipt)),
        ),
      ]),
  })

const stageView = (h: Html.HtmlBuilder<Message>, model: Model, status: EscrowStatus): Html.Html => {
  const buyer = model.setup.role === 'buyer'
  const stages = {
    Unfunded: () => (buyer ? fundIntro(h, model) : h.p([], [say(model.language, 'settlement.waitingFunding')])),
    Funded: () => (buyer ? h.p([], [deadlineText(model)]) : workerFunded(h, model, status)),
    Delivered: () =>
      h.div(styled(h, s.section()), [
        deliveredFacts(h, model, status),
        buyer ? buyerReview(h, model) : h.p([], [say(model.language, 'settlement.waitingReview')]),
      ]),
    Disputed: () => disputeView(h, model, status),
    Settled: () => settledView(h, model, status),
  }
  return stages[status.stage]()
}

/** The escrow's stage and the step it is the person's turn to sign. */
export const view = Submodel.defineView<Model, Message>((model, h) =>
  h.section(
    [h.AriaLabelledBy('job-payment'), ...styled(h, s.panel())],
    [
      h.h2([h.Id('job-payment')], [say(model.language, 'settlement.title')]),
      AsyncData.matchData(model.status, {
        onEmpty: () => Ui.waiting(h, say(model.language, 'settlement.loading')),
        onFailure: (problem) => Ui.problemNotice(h, model.language, problem),
        onData: (status) =>
          Option.match(inFlight(h, model), {
            onNone: () => stageView(h, model, status),
            onSome: (shownStep) => shownStep,
          }),
      }),
      Ui.maybeProblem(h, model.language, model.maybeProblem),
    ],
  ),
)
