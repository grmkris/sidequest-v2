import { Effect, Option } from 'effect'
import * as Server from 'foldkit/experimental/server'
import { provideAllCatalogs } from '@sidequest/i18n/all'
import { init } from './App.ts'
import { languageOf } from './Language.ts'
import { Flags } from './Model.ts'
import { Preload } from './Preload.ts'
import { pageData, sessionCookieOf } from './server/PageData.ts'
import { view } from './View.ts'
// oxlint-disable-next-line no-unassigned-import -- GlobalStyles registers the extracted Zyzz document styles.
import './GlobalStyles.ts'

provideAllCatalogs()
// Alchemy inlines the stack's VITE_ env at build time; hydration reads the release back from the stamped Flags.
const release = import.meta.env.VITE_SIDEQUEST_RELEASE ?? 'local-build'
export const application = { Flags, routing: {}, init, view }

/** Who may keep a copy of the page. One rendered for a session is that person's alone: never stored. One rendered for
 * anyone may be revalidated by any cache, and briefly reused by a shared one; one the server could not read data for
 * is not kept at all, so the next visitor gets the data. Either way it differs by language and by session cookie. */
const cacheControlFor = (hasSessionCookie: boolean, preload: Preload): string =>
  hasSessionCookie
    ? 'private, no-store'
    : Preload.guards.Nothing(preload)
      ? 'no-store'
      : 'public, max-age=0, s-maxage=10, must-revalidate'

/** Every page renders on the server at its route, in the reader's language, with the data the server read for it as
 * its visitor (the session cookie, forwarded alone to the API Worker, says who that is). Hydration starts from the same
 * Flags, so the browser reads nothing again; when the server's read failed the page renders as the browser builds it
 * and reads its data after hydration. */
export const renderPage: Server.EntryModule['renderPage'] = (request) =>
  Effect.runPromise(
    Effect.gen(function* () {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return Server.Responded(new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } }))
      }
      const url = new URL(request.url)
      const { sessionRead, preload } = yield* pageData(request)
      const hasSessionCookie = Option.isSome(sessionCookieOf(request.headers.get('cookie')))
      const flags: Flags = {
        language: languageOf(request.headers.get('accept-language')),
        timeZone: 'UTC',
        release,
        origin: url.origin,
        hasSessionCookie,
        sessionRead,
        preload,
      }
      const rendered = yield* Server.renderToString(application, { url: request.url, flags })
      return Server.Rendered(rendered, {
        headers: {
          'cache-control': cacheControlFor(hasSessionCookie, preload),
          vary: 'Accept-Language, Cookie',
          'content-language': flags.language,
        },
      })
    }),
  )

/** The viewport lets content run under a phone's rounded corners, where the shell pads it back in. */
export const renderDocument: Server.DocumentRenderer = (rendered, assets) =>
  Server.renderDocument(rendered, assets, {
    head: [
      '<meta name="color-scheme" content="light dark">',
      '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#f2f4f1">',
      '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0f1513">',
      '<link rel="icon" href="/favicon.svg">',
    ].join(''),
  }).replace(
    'content="width=device-width, initial-scale=1.0"',
    'content="width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content"',
  )
