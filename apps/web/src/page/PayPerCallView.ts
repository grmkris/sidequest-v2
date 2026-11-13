import type { IndexListingDetail, PayPerCall } from '@sidequest/protocol'
import type { Html } from 'foldkit'
import type { Language } from '../Language.ts'
import { styled } from '../Styled.ts'
import { say } from '../Text.ts'
import * as Ui from '../Ui.ts'
import * as s from '../Ui.styles.ts'
import { listingPriceText } from './Home.ts'

// A pay-per-call listing on the x402 rail (ADR-0006): what one call costs, where it is paid, how many payments the
// chain verified, and how to pay and call it. The website only shows it: it never calls the seller's resource and
// builds no payment, so the browser reaches no third-party host and the content security policy stays as it is. A
// person pays and calls from their agent (`x402_quote`) or any x402 client.

const payToFact = <Message>(h: Html.HtmlBuilder<Message>, language: Language, payPerCall: PayPerCall) =>
  Ui.fact(
    h,
    say(language, 'payPerCall.payTo'),
    h.span(
      [],
      [
        Ui.dataText(h, payPerCall.payTo),
        ' ',
        payPerCall.payToLinked
          ? Ui.chip(h, say(language, 'payPerCall.payToLinked'), 'done')
          : Ui.chip(h, say(language, 'payPerCall.payToUnlinked'), 'danger'),
      ],
    ),
  )

const howToPay = <Message>(h: Html.HtmlBuilder<Message>, language: Language, resource: string) =>
  h.section(
    [h.AriaLabel(say(language, 'payPerCall.howTitle')), ...styled(h, s.section())],
    [
      h.h3([], [say(language, 'payPerCall.howTitle')]),
      h.p([], [say(language, 'payPerCall.howWebsite')]),
      h.ol(
        [],
        [
          h.li([], [say(language, 'payPerCall.howAgent')]),
          h.li(
            [],
            [say(language, 'payPerCall.howClient'), ' ', h.code(styled(h, s.data()), [`curl -i '${resource}'`])],
          ),
          h.li([], [say(language, 'payPerCall.howReceipt')]),
        ],
      ),
    ],
  )

/** The pay-per-call panel of a listing on the x402 rail; nothing for an escrow listing. */
export const payPerCallSection = <Message>(
  h: Html.HtmlBuilder<Message>,
  language: Language,
  listing: IndexListingDetail,
): Html.Html => {
  const payPerCall = listing.payPerCall
  if (payPerCall === null) return h.empty
  return h.section(
    [h.AriaLabel(say(language, 'payPerCall.title')), ...styled(h, s.panel())],
    [
      h.h2([], [say(language, 'payPerCall.title')]),
      payPerCall.payToLinked ? h.empty : Ui.notice(h, 'danger', [h.p([], [say(language, 'payPerCall.payToWarning')])]),
      Ui.facts(h, [
        Ui.fact(h, say(language, 'listingPage.price'), listingPriceText(language, listing)),
        Ui.fact(h, say(language, 'payPerCall.resource'), Ui.dataText(h, payPerCall.resource)),
        payToFact(h, language, payPerCall),
        Ui.fact(h, say(language, 'payPerCall.receipts'), String(payPerCall.verifiedReceipts)),
      ]),
      Ui.notice(h, 'neutral', [h.p([], [say(language, 'payPerCall.noRefunds')])]),
      howToPay(h, language, payPerCall.resource),
    ],
  )
}
