import { Effect } from 'effect'
import * as Server from 'foldkit/experimental/server'
import { provideAllCatalogs } from '@sidequest/i18n/all'
import { init } from './App.ts'
import { languageOf } from './Language.ts'
import { Flags } from './Model.ts'
import { Preload } from './Preload.ts'
import { pageData } from './server/PageData.ts'
import { defaultInboxRelays, gatewayUrl } from './server/StageSettings.ts'
import { view } from './View.ts'
// oxlint-disable-next-line no-unassigned-import -- GlobalStyles registers the extracted Zyzz document styles.
import './GlobalStyles.ts'

provideAllCatalogs()
// Alchemy inlines the stack's VITE_ env at build time; hydration reads the release back from the stamped Flags.
const release = import.meta.env.VITE_SIDEQUEST_RELEASE ?? 'local-build'
export const application = { Flags, routing: {}, init, view }

/** Who may keep a copy of the page. Nothing in it is personal (the server does not know who the visitor is), so one
 * rendered with its data may be revalidated by any cache and briefly reused by a shared one; one the server could not
 * read data for is not kept at all, so the next visitor gets the data. It differs by language. */
const cacheControlFor = (preload: Preload): string =>
  Preload.guards.Nothing(preload) ? 'no-store' : 'public, max-age=0, s-maxage=10, must-revalidate'

/** Every page renders on the server at its route, in the reader's language, with the public data the server read for
 * it. Hydration starts from the same Flags, so the browser reads nothing again; when the server's read failed the page
 * renders as the browser builds it and reads its data after hydration. */
export const renderPage: Server.EntryModule['renderPage'] = (request) =>
  Effect.runPromise(
    Effect.gen(function* () {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return Server.Responded(new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } }))
      }
      const url = new URL(request.url)
      const preload = yield* pageData(request)
      const flags: Flags = {
        language: languageOf(request.headers.get('accept-language')),
        timeZone: 'UTC',
        release,
        origin: url.origin,
        preload,
        defaultInboxRelays: yield* defaultInboxRelays,
        maybeGatewayUrl: yield* gatewayUrl,
      }
      const rendered = yield* Server.renderToString(application, { url: request.url, flags })
      return Server.Rendered(rendered, {
        headers: {
          'cache-control': cacheControlFor(preload),
          vary: 'Accept-Language',
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
