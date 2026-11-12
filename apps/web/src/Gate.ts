import type { SessionView } from '@sidequest/protocol'
import type { Html } from 'foldkit'
import type { Language } from './Language.ts'
import { type AppRoute, signInHref } from './route.ts'
import { Session } from './Session.ts'
import { say } from './Text.ts'
import * as Ui from './Ui.ts'

/** A part of a page only a signed-in person can use: while the session is read it waits; signed out, it offers to
 * sign in and come back to `route`. */
export const signedInOnly = <Message>(
  h: Html.HtmlBuilder<Message>,
  config: { readonly language: Language; readonly session: Session; readonly route: AppRoute },
  render: (session: SessionView) => Html.Html,
): Html.Html => {
  const signInPrompt = () =>
    Ui.notice(h, 'neutral', [
      h.p([], [say(config.language, 'gate.signIn')]),
      h.p([], [h.a([h.Href(signInHref(config.route))], [say(config.language, 'gate.signInLink')])]),
    ])
  return Session.match(config.session, {
    Checking: () => Ui.waiting(h, say(config.language, 'gate.checking')),
    SignedOut: signInPrompt,
    Unknown: signInPrompt,
    SignedIn: ({ session }) => render(session),
    SigningOut: () => Ui.waiting(h, say(config.language, 'shell.signingOut')),
  })
}
