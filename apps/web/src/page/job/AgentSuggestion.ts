import { format } from '@sidequest/i18n'
import type { GrantRefusal } from '@sidequest/fold'
import { Option } from 'effect'
import type { Html } from 'foldkit'
import type { Language } from '../../Language.ts'
import { styled } from '../../Styled.ts'
import { type PlainKey, say } from '../../Text.ts'
import * as Ui from '../../Ui.ts'
import * as s from '../../Ui.styles.ts'
import { Message, type Suggestion } from './Job.ts'

/** Why the agent's accept did not count as the buyer's. */
const refusalKeys: Readonly<Record<GrantRefusal, PlainKey>> = {
  scopeMissing: 'job.suggestion.scopeMissing',
  outsideWindow: 'job.suggestion.outsideWindow',
  revoked: 'job.suggestion.revoked',
  otherKey: 'job.suggestion.notYourGrant',
  unknownGrant: 'job.suggestion.notYourGrant',
}

/** A key the buyer granted accepted this proposal, but the fold does not count it as the buyer's: a suggestion, and
 * why it does not count. One click publishes the buyer's own accept of it. */
export const agentSuggestion = (
  h: Html.HtmlBuilder<Message>,
  language: Language,
  suggestion: Suggestion,
  proposal: string,
) =>
  Ui.notice(h, 'neutral', [
    h.p([], [format(language, 'job.agentSuggests', { agent: suggestion.agent.label })]),
    h.p(styled(h, s.hint()), [
      Option.match(suggestion.maybeRefusal, {
        onNone: () => say(language, 'job.suggestion.noGrant'),
        onSome: (refusal) => say(language, refusalKeys[refusal]),
      }),
    ]),
    h.div(styled(h, s.actions()), [
      Ui.button(h, {
        label: say(language, 'job.acceptSuggestion'),
        onClick: Message.ClickedAcceptSuggestion({ proposal }),
        kind: 'primary',
      }),
    ]),
  ])

/** The buyer's agent accepted this proposal under the buyer's grant, which counts as the buyer's own accept. */
export const acceptedByYourAgent = (h: Html.HtmlBuilder<Message>, language: Language, agent: string) =>
  h.p(styled(h, s.meta()), [format(language, 'job.acceptedByYourAgent', { agent })])
