import { catalog as en } from './catalog-en.ts'
import { catalog as sl } from './catalog-sl.ts'
import { provideCatalog } from './index.ts'

/** Provide every language. Servers and tests call it once at start; the browser does not, so its
 * bundle carries only the language it loads. */
export const provideAllCatalogs = (): void => {
  provideCatalog('en', en)
  provideCatalog('sl', sl)
}
