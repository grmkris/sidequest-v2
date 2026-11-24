/** Times as the database keeps them: ISO strings with milliseconds, which sort as text. */
import { DateTime, Effect } from 'effect'

const dayMillis = 86_400_000

export const nowIso = Effect.map(DateTime.now, DateTime.formatIso)

/** A binding that is a number of days or hours; anything else, or nothing, is 0. */
export const amountOf = (binding: string | undefined, fallback = 0): number => {
  const value = Number(binding ?? '')
  return binding === undefined || binding.trim() === '' || !Number.isFinite(value) || value < 0 ? fallback : value
}

/** `days` from now (a fraction is fine), or null when `days` is 0: never. */
export const afterDays = (days: number) =>
  Effect.map(DateTime.now, (now) =>
    days > 0 ? DateTime.formatIso(DateTime.add(now, { milliseconds: Math.round(days * dayMillis) })) : null,
  )

/** `hours` ago. */
export const hoursAgo = (hours: number) =>
  Effect.map(DateTime.now, (now) =>
    DateTime.formatIso(DateTime.subtract(now, { milliseconds: Math.round(hours * 3_600_000) })),
  )
