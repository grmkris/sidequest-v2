import { format } from '@sidequest/i18n'
import type { ChainEnding, Deadlines, FundingView, JobView, OperatorOutcome } from '@sidequest/fold'
import type { IndexPaymentStatus, RelayedCall } from '@sidequest/protocol'
import { Array, Match, Option } from 'effect'
import type { Html } from 'foldkit'
import { formatAmount, workerPart } from '../../Amount.ts'
import type { Language } from '../../Language.ts'
import { styled } from '../../Styled.ts'
import { formatInstant, type PlainKey, say } from '../../Text.ts'
import * as Ui from '../../Ui.ts'
import * as s from '../../Ui.styles.ts'
import * as js from './Job.styles.ts'

// What the chain recorded of the escrow, read-only, for everyone: the funding, the delivery and the windows it opened,
// a rejection and the arbitrator's deadline, how it ended and with what amounts, and the transactions Sidequest relayed.
// No block explorer is configured for Arc testnet, so transaction hashes show as text to copy.

type ChainReader = {
  readonly view: JobView
  readonly maybePayment: Option.Option<IndexPaymentStatus>
  readonly language: Language
  readonly timeZone: string
}

const fundingFacts = <M>(h: Html.HtmlBuilder<M>, { language, timeZone }: ChainReader, funding: FundingView) =>
  Ui.facts(h, [
    Ui.fact(h, say(language, 'job.chain.amount'), formatAmount(funding.fact.amount, funding.fact.asset, language)),
    Ui.fact(h, say(language, 'job.chain.deadline'), formatInstant(funding.fact.deliveryDeadline, language, timeZone)),
    Ui.fact(
      h,
      say(language, 'job.chain.terms'),
      say(
        language,
        funding.terms === 'unknown'
          ? 'job.chain.termsUnknown'
          : funding.termsMatchChain
            ? 'job.chain.termsMatch'
            : 'job.chain.termsDiffer',
      ),
    ),
    Ui.fact(h, say(language, 'job.chain.payment'), Ui.dataText(h, funding.fact.paymentHash)),
  ])

const outcomeKeys: Readonly<Record<Exclude<OperatorOutcome, 'Ruled'>, PlainKey>> = {
  Approved: 'job.chain.outcome.approved',
  AcceptedBySilence: 'job.chain.outcome.silence',
  Unruled: 'job.chain.outcome.unruled',
  Undelivered: 'job.chain.outcome.undelivered',
}

/** How the escrow ended, and where every unit of it went: the worker's part, the fee, and what came back. */
const endingView = <M>(h: Html.HtmlBuilder<M>, language: Language, funding: FundingView, ending: ChainEnding) => {
  const amount = (atomic: string) => formatAmount(atomic, funding.fact.asset, language)
  return Match.valueTags(ending, {
    Settled: (settled) =>
      h.div(styled(h, s.section()), [
        Ui.notice(h, 'done', [
          h.p(
            [],
            [
              settled.outcome === 'Ruled'
                ? format(language, 'job.chain.outcome.ruled', { share: `${settled.workerShareBps / 100}%` })
                : say(language, outcomeKeys[settled.outcome]),
            ],
          ),
        ]),
        Ui.facts(h, [
          Ui.fact(
            h,
            say(language, 'job.chain.toWorker'),
            amount(workerPart(settled.capturedAmount, settled.feeAmount)),
          ),
          Ui.fact(h, say(language, 'job.chain.fee'), amount(settled.feeAmount)),
          Ui.fact(h, say(language, 'job.chain.toBuyer'), amount(settled.refundedAmount)),
        ]),
      ]),
    Reclaimed: (reclaimed) =>
      Ui.notice(h, 'done', [h.p([], [format(language, 'job.chain.reclaimed', { amount: amount(reclaimed.amount) })])]),
  })
}

const deadlineKeys: ReadonlyArray<readonly [keyof Deadlines, PlainKey]> = [
  ['deliveryOverdue', 'job.chain.label.deliveryOverdue'],
  ['reviewWindowOpen', 'job.chain.label.reviewWindowOpen'],
  ['arbitrationOpen', 'job.chain.label.arbitrationOpen'],
  ['reclaimable', 'job.chain.label.reclaimable'],
]

/** The fold's deadline labels that hold now. */
const deadlineChips = <M>(h: Html.HtmlBuilder<M>, language: Language, deadlines: Deadlines) =>
  Array.match(
    Array.filter(deadlineKeys, ([field]) => deadlines[field]),
    {
      onEmpty: () => h.empty,
      onNonEmpty: (held) =>
        h.ul(
          [h.AriaLabel(say(language, 'job.chain.deadlines')), ...styled(h, js.labels())],
          Array.map(held, ([field, key]) => h.keyed('li')(field, [], [Ui.chip(h, say(language, key))])),
        ),
    },
  )

const intentKeys: ReadonlyArray<readonly [string, PlainKey]> = [
  ['fund:', 'job.chain.call.fund'],
  ['delivery:', 'job.chain.call.delivery'],
  ['approval:', 'job.chain.call.approval'],
  ['rejection:', 'job.chain.call.rejection'],
  ['ruling:', 'job.chain.call.ruling'],
]

const callName = (language: Language, intent: string) =>
  say(
    language,
    Option.match(
      Array.findFirst(intentKeys, ([prefix]) => intent.startsWith(prefix)),
      { onNone: (): PlainKey => 'job.chain.call.deadline', onSome: ([, key]) => key },
    ),
  )

const callRow = <M>(h: Html.HtmlBuilder<M>, language: Language, call: RelayedCall) =>
  Option.match(Option.fromNullishOr(call.transactionHash), {
    onNone: () => h.empty,
    onSome: (hash) =>
      h.keyed('li')(call.intent, styled(h, s.row()), [
        h.p([], [callName(language, call.intent)]),
        h.p(styled(h, s.meta()), [say(language, 'money.transaction'), ' ', Ui.dataText(h, hash)]),
      ]),
  })

/** The transactions Sidequest relayed for the payment, oldest first. */
const transactions = <M>(h: Html.HtmlBuilder<M>, language: Language, maybePayment: Option.Option<IndexPaymentStatus>) =>
  Option.match(
    Option.filter(maybePayment, (payment) => Array.some(payment.relayed, (call) => call.transactionHash !== null)),
    {
      onNone: () => h.empty,
      onSome: (payment) =>
        h.ul(
          [h.AriaLabel(say(language, 'job.chain.transactions')), ...styled(h, s.rows())],
          Array.map(payment.relayed, (call) => callRow(h, language, call)),
        ),
    },
  )

/** What the chain recorded of the escrow, read-only. */
export const chainSection = <M>(h: Html.HtmlBuilder<M>, reader: ChainReader): Html.Html => {
  const { view, language, timeZone } = reader
  const at = (seconds: number) => formatInstant(seconds, language, timeZone)
  return Option.match(Option.fromNullishOr(view.funding), {
    onNone: () => h.empty,
    onSome: (funding) =>
      h.section(
        [h.AriaLabelledBy('job-chain'), ...styled(h, s.panel())],
        [
          h.h2([h.Id('job-chain')], [say(language, 'job.chain.title')]),
          deadlineChips(h, language, view.deadlines),
          fundingFacts(h, reader, funding),
          view.delivery === null
            ? h.empty
            : h.p(
                [],
                [
                  format(language, 'job.chain.delivered', {
                    date: at(view.delivery.deliveredAt),
                    until: at(view.delivery.reviewEndsAt),
                  }),
                ],
              ),
          view.rejection === null
            ? h.empty
            : Ui.notice(h, view.ending === null ? 'danger' : 'neutral', [
                h.p(
                  [],
                  [
                    format(language, 'job.chain.rejected', {
                      date: at(view.rejection.rejectedAt),
                      until: at(view.rejection.arbitrationEndsAt),
                    }),
                  ],
                ),
              ]),
          view.ending === null ? h.empty : endingView(h, language, funding, view.ending),
          transactions(h, language, reader.maybePayment),
        ],
      ),
  })
}
