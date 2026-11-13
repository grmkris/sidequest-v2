import type { Html } from 'foldkit'
import type { Language } from './Language.ts'
import { Me } from './Me.ts'
import { type AppRoute, identityHref } from './route.ts'
import type { SignerIdentity } from './Signer.ts'
import { say } from './Text.ts'
import * as Ui from './Ui.ts'

/** A part of a page that acts as the person's Nostr key: while the browser looks for a signer it waits; with none
 * ready, it leads to the identity page, which comes back to `route`. */
export const signerOnly = <Message>(
  h: Html.HtmlBuilder<Message>,
  config: { readonly language: Language; readonly me: Me; readonly route: AppRoute },
  render: (identity: SignerIdentity) => Html.Html,
): Html.Html =>
  Me.match(config.me, {
    Detecting: () => Ui.waiting(h, say(config.language, 'me.detecting')),
    NoSigner: () =>
      Ui.notice(h, 'neutral', [
        h.p([], [say(config.language, 'me.needSigner')]),
        h.p([], [h.a([h.Href(identityHref(config.route))], [say(config.language, 'me.setUpLink')])]),
      ]),
    Ready: ({ identity }) => render(identity),
  })
