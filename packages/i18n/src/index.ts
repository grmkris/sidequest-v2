import { IntlMessageFormat } from 'intl-messageformat'

import type { MessageKey, MessageValues } from './generated.ts'
import { pseudoMessage } from './pseudo.ts'

export type { MessageKey, MessageValues, RichTextValue } from './generated.ts'
export { catalogVersion } from './generated.ts'
export type Locale = 'en' | 'sl' | 'en-XA' | 'ar-XB'

const defaultLocale: Locale = 'en'
const formatterLimit = 4096
const formatters = new Map<string, IntlMessageFormat>()

type Language = 'en' | 'sl'
type Catalog = Readonly<Record<MessageKey, string>>

const baseLocale = (locale: Locale): Language => (locale === 'sl' ? 'sl' : 'en')

const catalogs = new Map<Language, Catalog>()

/** Make a language's messages available. Servers and tests provide every language at start
 * (`@sidequest/i18n/all`); the browser loads only the one its page shows (`loadCatalog`). */
export const provideCatalog = (language: Language, catalog: Catalog): void => {
  catalogs.set(language, catalog)
}

/** Load a language's messages on demand: the page's language before hydrating, another one before
 * switching to it. */
export const loadCatalog = async (locale: Locale): Promise<void> => {
  const language = baseLocale(locale)
  if (catalogs.has(language)) return
  const { catalog } = language === 'sl' ? await import('./catalog-sl.ts') : await import('./catalog-en.ts')
  provideCatalog(language, catalog)
}

const catalogFor = (locale: Locale): Catalog => {
  const catalog = catalogs.get(baseLocale(locale))
  // Formatting before the language is loaded is a wiring defect, not a state the page can show.
  if (catalog === undefined) throw new Error(`The ${baseLocale(locale)} catalog is not loaded`)
  return catalog
}

const formatterFor = (locale: Locale, key: MessageKey): IntlMessageFormat => {
  const cacheKey = `${locale}:${key}`
  const cached = formatters.get(cacheKey)
  if (cached !== undefined) return cached
  const source = new IntlMessageFormat(catalogFor(locale)[key], baseLocale(locale))
  const formatter =
    locale === 'en-XA' || locale === 'ar-XB'
      ? new IntlMessageFormat(pseudoMessage(source.getAst(), locale), 'en')
      : source
  if (formatters.size >= formatterLimit) {
    const oldest = formatters.keys().next().value
    if (oldest !== undefined) formatters.delete(oldest)
  }
  formatters.set(cacheKey, formatter)
  return formatter
}

export const normalizeLocale = (input: string | undefined): Locale => {
  if (input === 'en-XA' || input === 'ar-XB') return input
  if (/^sl(?:-[a-z0-9]{2,8})*$/i.test(input ?? '')) return 'sl'
  return defaultLocale
}

export const direction = (locale: Locale): 'ltr' | 'rtl' => (locale === 'ar-XB' ? 'rtl' : 'ltr')

export const formatRich = <K extends MessageKey, T = string>(
  locale: Locale,
  key: K,
  values: MessageValues<K, T>,
): string | T | (string | T)[] => {
  const rendered = formatterFor(locale, key).format<T>(values)
  return rendered
}

export const format = <K extends MessageKey>(locale: Locale, key: K, values: MessageValues<K>): string => {
  const rendered = formatRich(locale, key, values)
  return typeof rendered === 'string' ? rendered : rendered.join('')
}

export const text = <K extends MessageKey>(key: K, values: MessageValues<K>): string => {
  return format(defaultLocale, key, values)
}
