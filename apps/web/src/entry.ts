import { Runtime } from 'foldkit'
import { loadCatalog } from '@sidequest/i18n'
import { Flags, Message, Model, init, update, view } from './App.ts'
// oxlint-disable-next-line no-unassigned-import -- GlobalStyles registers the extracted Zyzz document styles.
import './GlobalStyles.ts'

await loadCatalog('en')
const application = Runtime.makeApplication({
  Model,
  Flags,
  init,
  update,
  view,
  container: document.getElementById('root'),
  devTools: { Message },
})
Runtime.hydrate(application)
