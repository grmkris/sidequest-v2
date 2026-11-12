import { Effect } from 'effect'
import * as Server from 'foldkit/experimental/server'
import { provideAllCatalogs } from '@sidequest/i18n/all'
import { Flags, init, view } from './App.ts'
// oxlint-disable-next-line no-unassigned-import -- GlobalStyles registers the extracted Zyzz document styles.
import './GlobalStyles.ts'

provideAllCatalogs()
// Alchemy inlines the stack's VITE_ env at build time; hydration reads the release back from the stamped Flags.
const release = import.meta.env.VITE_SIDEQUEST_RELEASE ?? 'local-build'
export const application = { Flags, init, view }
export const renderPage: Server.EntryModule['renderPage'] = (request) =>
  Effect.runPromise(
    Server.renderToString(application, {
      flags: { locale: 'en', release },
    }).pipe(Effect.map((rendered) => Server.Rendered(rendered))),
  )
export const renderDocument: Server.DocumentRenderer = (rendered, assets) => Server.renderDocument(rendered, assets)
