import { Effect } from 'effect'
import * as Server from 'foldkit/experimental/server'
import { provideAllCatalogs } from '@sidequest/i18n/all'
import { Flags, init, view } from './App.ts'
// oxlint-disable-next-line no-unassigned-import -- GlobalStyles registers the extracted Zyzz document styles.
import './GlobalStyles.ts'

provideAllCatalogs()
export const application = { Flags, init, view }
export const renderPage: Server.EntryModule['renderPage'] = (request) =>
  Effect.runPromise(
    Server.renderToString(application, {
      flags: { locale: 'en', release: 'local-build' },
    }).pipe(Effect.map((rendered) => Server.Rendered(rendered))),
  )
export const renderDocument: Server.DocumentRenderer = (rendered, assets) => Server.renderDocument(rendered, assets)
