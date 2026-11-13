import { Layer } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import { Runtime } from 'foldkit'
import { loadCatalog, normalizeLocale } from '@sidequest/i18n'
import { sidequestClientLayer } from './Api.ts'
import { Flags, Message, Model, init, subscriptions, update } from './App.ts'
import { routing } from './Navigation.ts'
import { view } from './View.ts'
import { roomsLayer } from './Rooms.ts'
import { signersLayer } from './Signer.ts'
import { walletLayer } from './Wallet.ts'
// oxlint-disable-next-line no-unassigned-import -- GlobalStyles registers the extracted Zyzz document styles.
import './GlobalStyles.ts'

// Only the page's language ships before hydration; the server stamped it on <html>.
await loadCatalog(normalizeLocale(document.documentElement.lang))
const application = Runtime.makeApplication({
  Model,
  Flags,
  init,
  update,
  view,
  routing,
  subscriptions,
  container: document.getElementById('root'),
  devTools: { Message },
  resources: roomsLayer(window.location.origin).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        sidequestClientLayer(window.location.origin).pipe(Layer.provide(FetchHttpClient.layer)),
        walletLayer(window),
        signersLayer(window),
      ),
    ),
  ),
})
Runtime.hydrate(application)
