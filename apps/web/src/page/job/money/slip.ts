import { format } from '@sidequest/i18n'
import type { EscrowFunding } from '@sidequest/protocol'
import type { Html } from 'foldkit'
import { formatAmount, splitFee } from '../../../Amount.ts'
import type { Language } from '../../../Language.ts'
import { styled } from '../../../Styled.ts'
import { formatDuration, formatInstant, say } from '../../../Text.ts'
import * as Ui from '../../../Ui.ts'
import * as s from '../../../Ui.styles.ts'
import * as js from '../Job.styles.ts'
import { Message } from './message.ts'

// What the buyer signs to fund a job, in plain words, before the wallet shows it: every parameter the one ERC-3009
// signature binds, as the API quoted it from the proposal's signed terms. The contract leaves readability to the site.

const percentOf = (bps: number): string => `${bps / 100}%`

const address = (h: Html.HtmlBuilder<Message>, value: string) => Ui.dataText(h, value)

const sentences = (
  h: Html.HtmlBuilder<Message>,
  language: Language,
  timeZone: string,
  funding: EscrowFunding,
): ReadonlyArray<Html.Html> => {
  const amount = (atomic: string) => formatAmount(atomic, funding.asset, language)
  const { paymentInfo: info, jobParams: params } = funding
  const { fee, worker } = splitFee(funding.amount, info.maxFeeBps)
  const at = (seconds: number) => formatInstant(seconds, language, timeZone)
  return [
    h.li([], [say(language, 'slip.binds')]),
    h.li([], [say(language, 'slip.escrow'), ' ', address(h, funding.escrow)]),
    h.li(
      [],
      [format(language, 'slip.worker', { deadline: at(params.deliveryDeadline) }), ' ', address(h, info.receiver)],
    ),
    h.li([], [format(language, 'slip.review', { review: formatDuration(params.reviewWindow, language) })]),
    h.li(
      [],
      [
        format(language, 'slip.reject', {
          window: formatDuration(params.disputeWindow + params.arbitrationWindow, language),
        }),
        ' ',
        address(h, params.arbitrator),
      ],
    ),
    h.li([], [say(language, 'slip.undelivered')]),
    h.li(
      [],
      [
        format(language, 'slip.fee', { fee: amount(fee), percent: percentOf(info.maxFeeBps), worker: amount(worker) }),
        ' ',
        address(h, info.feeReceiver),
      ],
    ),
    h.li([], [format(language, 'slip.expiry', { date: at(info.authorizationExpiry) })]),
    h.li([], [format(language, 'slip.wallet', { date: at(info.preApprovalExpiry) })]),
  ]
}

/** The wallet is on another chain than the one the authorization is for: switch it before signing. */
export const switchPrompt = (h: Html.HtmlBuilder<Message>, language: Language, walletChain: number): Html.Html =>
  Ui.notice(h, 'neutral', [
    h.p([], [format(language, 'money.wrongChain', { chain: walletChain })]),
    h.div(styled(h, s.actions()), [
      Ui.button(h, {
        label: say(language, 'money.switchChain'),
        onClick: Message.ClickedSwitchNetwork(),
        kind: 'primary',
      }),
      Ui.button(h, { label: say(language, 'common.cancel'), onClick: Message.ClickedCancel() }),
    ]),
  ])

/** The slip: the amount, what happens to it in every case, and the two actions, once the wallet is on the right chain. */
export const fundingSlip = (
  h: Html.HtmlBuilder<Message>,
  config: {
    readonly language: Language
    readonly timeZone: string
    readonly funding: EscrowFunding
    readonly walletChain: number
  },
): Html.Html => {
  const { language, timeZone, funding, walletChain } = config
  const onChain = walletChain === funding.typedData.domain.chainId
  return h.section(
    [h.AriaLabelledBy('funding-slip'), ...styled(h, js.slip())],
    [
      h.h3([h.Id('funding-slip')], [say(language, 'slip.title')]),
      h.p(styled(h, js.slipAmount()), [formatAmount(funding.amount, funding.asset, language)]),
      h.ul(styled(h, js.slipTerms()), sentences(h, language, timeZone, funding)),
      onChain
        ? h.div(styled(h, s.actions()), [
            Ui.button(h, { label: say(language, 'slip.sign'), onClick: Message.ClickedSign(), kind: 'seal' }),
            Ui.button(h, { label: say(language, 'slip.notNow'), onClick: Message.ClickedCancel() }),
          ])
        : switchPrompt(h, language, walletChain),
    ],
  )
}
