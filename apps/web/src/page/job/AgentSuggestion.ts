import { format } from '@sidequest/i18n'
import type { Html } from 'foldkit'
import type { Language } from '../../Language.ts'
import { styled } from '../../Styled.ts'
import { say } from '../../Text.ts'
import * as Ui from '../../Ui.ts'
import * as s from '../../Ui.styles.ts'
import { Message } from './Job.ts'

/** An agent the buyer granted accepted this proposal: a suggestion, which the fold does not count as the buyer's. One
 * click publishes the buyer's own accept of it. */
export const agentSuggestion = (h: Html.HtmlBuilder<Message>, language: Language, agent: string, proposal: string) =>
  Ui.notice(h, 'neutral', [
    h.p([], [format(language, 'job.agentSuggests', { agent })]),
    h.p(styled(h, s.hint()), [say(language, 'job.agentSuggestsNote')]),
    h.div(styled(h, s.actions()), [
      Ui.button(h, {
        label: say(language, 'job.acceptSuggestion'),
        onClick: Message.ClickedAcceptSuggestion({ proposal }),
        kind: 'primary',
      }),
    ]),
  ])
