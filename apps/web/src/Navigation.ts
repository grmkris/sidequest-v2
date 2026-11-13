import { Effect, Schema } from 'effect'
import { Command, Dom } from 'foldkit'
import { load, pushUrl, UrlRequest } from 'foldkit/navigation'
import { toString as urlToString, type Url } from 'foldkit/url'
import { Message } from './Message.ts'

// Moving between pages: every link to this site opens inside the document, and the new page's title takes focus so a
// screen reader starts there.

export const NavigateInternal = Command.define('NavigateInternal', {
  args: { href: Schema.String },
  messages: [Message.CompletedNavigate],
  execute: ({ href }) => pushUrl(href).pipe(Effect.as(Message.CompletedNavigate())),
})

const LoadExternal = Command.define('LoadExternal', {
  args: { href: Schema.String },
  messages: [Message.CompletedNavigate],
  execute: ({ href }) => load(href).pipe(Effect.as(Message.CompletedNavigate())),
})

/** The new page's title takes focus, and the page starts at its top. */
export const FocusTitle = Command.define('FocusTitle', {
  messages: [Message.CompletedFocusTitle],
  execute: Dom.focus('#main h1', { makeFocusable: true }).pipe(
    Effect.andThen(Effect.sync(() => window.scrollTo({ top: 0 }))),
    Effect.ignore,
    Effect.as(Message.CompletedFocusTitle()),
  ),
})

export const routing = {
  onUrlRequest: (request: UrlRequest) => Message.ClickedLink({ request }),
  onUrlChange: (url: Url) => Message.ChangedUrl({ url }),
}

export const followLink = (request: UrlRequest) =>
  UrlRequest.match(request, {
    Internal: ({ url }) => NavigateInternal({ href: urlToString(url) }),
    External: ({ href }) => LoadExternal({ href }),
  })
