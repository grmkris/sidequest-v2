import { format, type MessageKey, type MessageValues } from '@sidequest/i18n'
import type { Language } from './Language.ts'

/** A message that takes no values. */
export type PlainKey = {
  readonly [Key in MessageKey]: MessageValues<Key> extends Readonly<Record<string, never>> ? Key : never
}[MessageKey]

/** A message that takes no values, in `language`. */
export const say = (language: Language, key: PlainKey): string => format(language, key, {})

const locales: Readonly<Record<Language, string>> = { en: 'en', sl: 'sl-SI' }

/** An instant (Unix seconds) as a date and time in `timeZone`. The server renders in UTC, which the page hydrates
 * with, and the browser then reads its own zone (`ReadTimeZone`), so hydration draws exactly what the server sent. */
export const formatInstant = (seconds: number, language: Language, timeZone: string): string =>
  new Intl.DateTimeFormat(locales[language], { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(
    seconds * 1000,
  )

const minute = 60
const hour = 60 * minute
const day = 24 * hour

/** A window in whole days, else hours, else minutes. */
export const formatDuration = (seconds: number, language: Language): string => {
  if (seconds % day === 0) {
    return format(language, 'time.days', { count: seconds / day })
  }
  if (seconds % hour === 0) {
    return format(language, 'time.hours', { count: seconds / hour })
  }
  return format(language, 'time.minutes', { count: Math.ceil(seconds / minute) })
}

/** A long hex value with its middle elided: `0x1234…cdef`. The whole value stays in the element's title. */
export const shortHex = (hex: string): string => (hex.length <= 14 ? hex : `${hex.slice(0, 6)}…${hex.slice(-4)}`)
