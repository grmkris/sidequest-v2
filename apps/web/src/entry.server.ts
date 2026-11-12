import { Effect } from 'effect'
import * as Server from 'foldkit/experimental/server'
import { provideAllCatalogs } from '@sidequest/i18n/all'
import { sessionCookieName } from '@sidequest/protocol'
import { init } from './App.ts'
import { languageOf } from './Language.ts'
import { Flags } from './Model.ts'
import { view } from './View.ts'
// oxlint-disable-next-line no-unassigned-import -- GlobalStyles registers the extracted Zyzz document styles.
import './GlobalStyles.ts'

provideAllCatalogs()
// Alchemy inlines the stack's VITE_ env at build time; hydration reads the release back from the stamped Flags.
const release = import.meta.env.VITE_SIDEQUEST_RELEASE ?? 'local-build'
export const application = { Flags, routing: {}, init, view }

/** Every page renders on the server at its route, in the reader's language, without data: pages read their data in the
 * browser after hydration, so a page is never served with another person's view of a job. */
export const renderPage: Server.EntryModule['renderPage'] = (request) =>
  Effect.runPromise(
    Effect.gen(function* () {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return Server.Responded(new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } }))
      }
      const url = new URL(request.url)
      const flags: Flags = {
        language: languageOf(request.headers.get('accept-language')),
        release,
        origin: url.origin,
        hasSessionCookie: (request.headers.get('cookie') ?? '').includes(`${sessionCookieName}=`),
      }
      const rendered = yield* Server.renderToString(application, { url: request.url, flags })
      return Server.Rendered(rendered, {
        headers: {
          'cache-control': 'private, no-store',
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
