import { format } from '@sidequest/i18n'
import type { FundingRequest } from '@sidequest/protocol'
import type { Html } from 'foldkit'
import { formatAmount, splitFee } from '../../Amount.ts'
import type { Language } from '../../Language.ts'
import { styled } from '../../Styled.ts'
import { formatDuration, formatInstant, say } from '../../Text.ts'
import * as Ui from '../../Ui.ts'
import * as s from '../../Ui.styles.ts'
import * as js from './Job.styles.ts'
import { Message } from './Settlement.ts'

// What the buyer signs to fund a job, in plain words, before the wallet shows it: every parameter the one ERC-3009
// signature binds. The contract README leaves readability to the website, so this is where it lives.

const percentOf = (bps: number): string => `${bps / 100}%`

const address = (h: Html.HtmlBuilder<Message>, value: string) => Ui.dataText(h, value)

const sentences = (
  h: Html.HtmlBuilder<Message>,
  language: Language,
  request: FundingRequest,
): ReadonlyArray<Html.Html> => {
  const amount = (atomic: string) => formatAmount(atomic, request.asset, language)
  const { fee, worker } = splitFee(request.amount, request.feeBps)
  return [
    h.li([], [say(language, 'slip.escrow'), ' ', address(h, request.escrow)]),
    h.li(
      [],
      [
        format(language, 'slip.worker', { deadline: formatInstant(request.deliveryDeadline, language) }),
        ' ',
        address(h, request.receiver),
      ],
    ),
    h.li([], [format(language, 'slip.review', { review: formatDuration(request.reviewWindowSeconds, language) })]),
    h.li(
      [],
      [
        format(language, 'slip.reject', {
          window: formatDuration(request.disputeWindowSeconds + request.arbitrationWindowSeconds, language),
        }),
        ' ',
        address(h, request.arbitrator),
      ],
    ),
    h.li([], [say(language, 'slip.undelivered')]),
    h.li(
      [],
      [format(language, 'slip.fee', { fee: amount(fee), percent: percentOf(request.feeBps), worker: amount(worker) })],
    ),
    h.li([], [format(language, 'slip.expiry', { date: formatInstant(request.authorizationExpiry, language) })]),
    h.li([], [format(language, 'slip.wallet', { date: formatInstant(request.preApprovalExpiry, language) })]),
  ]
}

/** The slip: the amount, what happens to it in every case, and the two actions. */
export const fundingSlip = (h: Html.HtmlBuilder<Message>, language: Language, request: FundingRequest): Html.Html =>
  h.section(
    [h.AriaLabelledBy('funding-slip'), ...styled(h, js.slip())],
    [
      h.h3([h.Id('funding-slip')], [say(language, 'slip.title')]),
      h.p(styled(h, js.slipAmount()), [formatAmount(request.amount, request.asset, language)]),
      h.ul(styled(h, js.slipTerms()), sentences(h, language, request)),
      h.div(styled(h, s.actions()), [
        Ui.button(h, { label: say(language, 'slip.sign'), onClick: Message.ClickedSignFunding(), kind: 'seal' }),
        Ui.button(h, { label: say(language, 'slip.notNow'), onClick: Message.ClickedCancel() }),
      ]),
    ],
  )
