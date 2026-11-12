import { Amount, type AssetId, findAsset } from '@sidequest/protocol'
import { Option, Schema, String } from 'effect'
import type { Language } from './Language.ts'

// Amounts travel as integers in an asset's atomic units, as decimal strings (`Amount`). The site turns them into the
// asset's whole units for people and back again with string arithmetic only: a float never holds money.

const separators: Readonly<Record<Language, { readonly group: string; readonly decimal: string }>> = {
  en: { group: ',', decimal: '.' },
  sl: { group: '.', decimal: ',' },
}

const groupThousands = (digits: string, separator: string): string =>
  digits.replace(/\B(?=(\d{3})+(?!\d))/gu, separator)

/** An atomic amount in whole units, for `language`: at least two decimals for an asset that has them, no trailing
 * zeros beyond that, and the language's own separators. `250000000` at 6 decimals is `250.00` in English. */
export const formatUnits = (amount: string, decimals: number, language: Language): string =>
  unitsWith(amount, decimals, separators[language])

/** An atomic amount in whole units as a person would type it back: no group separators. */
export const editableUnits = (amount: string, decimals: number, language: Language): string =>
  unitsWith(amount, decimals, { group: '', decimal: separators[language].decimal })

const unitsWith = (
  amount: string,
  decimals: number,
  { group, decimal }: { readonly group: string; readonly decimal: string },
): string => {
  const padded = amount.padStart(decimals + 1, '0')
  const whole = padded.slice(0, padded.length - decimals)
  const fraction = padded.slice(padded.length - decimals)
  const kept = fraction.replace(/0+$/u, '').padEnd(Math.min(2, decimals), '0')
  const grouped = groupThousands(whole, group)
  return String.isEmpty(kept) ? grouped : `${grouped}${decimal}${kept}`
}

/** What a person typed as whole units, as an atomic amount: digits with at most one of the language's decimal
 * separators and at most `decimals` digits after it. Group separators, signs and the other language's separator are
 * refused rather than guessed at, because `1,000` means a thousand in English and one in Slovenian. */
export const parseUnits = (input: string, decimals: number, language: Language): Option.Option<Amount> => {
  const { decimal } = separators[language]
  const pattern = decimal === '.' ? /^(\d+)(?:\.(\d*))?$/u : /^(\d+)(?:,(\d*))?$/u
  const match = pattern.exec(input.trim())
  if (match === null) {
    return Option.none()
  }
  const whole = match[1] ?? ''
  const fraction = match[2] ?? ''
  if (fraction.length > decimals) {
    return Option.none()
  }
  const atomic = `${whole}${fraction.padEnd(decimals, '0')}`.replace(/^0+(?=\d)/u, '')
  return Schema.decodeUnknownOption(Amount)(atomic)
}

/** An amount of a registered asset for people: `250.00 USDC`. An unregistered asset shows its atomic units and id. */
export const formatAmount = (amount: string, asset: AssetId, language: Language): string =>
  Option.match(findAsset(asset), {
    onNone: () => `${amount} ${asset}`,
    onSome: (registered) => `${formatUnits(amount, registered.decimals, language)} ${registered.symbol}`,
  })

/** The fee and the worker's part of a captured amount: `floor(amount × feeBps / 10 000)` to the fee receiver and the
 * rest to the worker, as the escrow splits it. */
export const splitFee = (amount: string, feeBps: number): { readonly fee: string; readonly worker: string } => {
  const total = BigInt(amount)
  const fee = (total * BigInt(feeBps)) / 10_000n
  return { fee: fee.toString(), worker: (total - fee).toString() }
}
