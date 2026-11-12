import { Schema } from 'effect'

/** The languages the site speaks. */
export const Language = Schema.Literals(['en', 'sl'])
export type Language = typeof Language.Type

/** The language a request prefers, from its `Accept-Language`: Slovenian when it comes first among the two. */
export const languageOf = (acceptLanguage: string | null): Language => {
  const preferred = (acceptLanguage ?? '')
    .split(',')
    .map((part) => part.split(';')[0]?.trim().toLowerCase() ?? '')
    .find((tag) => tag.startsWith('sl') || tag.startsWith('en'))
  return preferred?.startsWith('sl') === true ? 'sl' : 'en'
}
