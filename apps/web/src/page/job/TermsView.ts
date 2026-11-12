import type { Terms } from '@sidequest/protocol'
import { Array } from 'effect'
import type { Html } from 'foldkit'
import { formatAmount } from '../../Amount.ts'
import type { Language } from '../../Language.ts'
import { styled } from '../../Styled.ts'
import { formatDuration, formatInstant, say } from '../../Text.ts'
import * as Ui from '../../Ui.ts'
import * as js from './Job.styles.ts'

/** A proposal's or an agreement's terms as a list of facts: the amount first, then what is delivered, by when, and the
 * windows that follow a delivery. */
export const termsView = <Message>(
  h: Html.HtmlBuilder<Message>,
  language: Language,
  timeZone: string,
  terms: Terms,
): Html.Html =>
  Ui.facts(h, [
    Ui.fact(
      h,
      say(language, 'terms.amount'),
      h.strong(styled(h, js.amount()), [formatAmount(terms.amount, terms.asset, language)]),
    ),
    Ui.fact(
      h,
      say(language, 'terms.deliverables'),
      h.ul(
        styled(h, js.deliverables()),
        Array.map(Array.dedupe(terms.deliverables), (deliverable) => h.keyed('li')(deliverable, [], [deliverable])),
      ),
    ),
    Ui.fact(h, say(language, 'terms.deadline'), formatInstant(terms.deliveryDeadline, language, timeZone)),
    Ui.fact(h, say(language, 'terms.review'), formatDuration(terms.reviewWindowSeconds, language)),
    Ui.fact(h, say(language, 'terms.dispute'), formatDuration(terms.disputeWindowSeconds, language)),
    Ui.fact(h, say(language, 'terms.arbitration'), formatDuration(terms.arbitrationWindowSeconds, language)),
  ])
