import { Schema } from 'effect'

const maxUint256 = (2n ** 256n - 1n).toString()

// Canonical digit strings of equal length compare like the integers they spell.
const fitsUint256 = (value: string) =>
  value.length < maxUint256.length || (value.length === maxUint256.length && value <= maxUint256)

/**
 * A non-negative integer in an asset's atomic units, as a decimal string with no sign, no leading
 * zeros and no fraction. Bounded by uint256 so every amount fits an EVM word.
 */
export const Amount = Schema.String.check(
  Schema.isPattern(/^(0|[1-9][0-9]*)$/u),
  Schema.makeFilter(fitsUint256, { expected: 'uint256' }),
).pipe(Schema.brand('Amount'))
export type Amount = typeof Amount.Type
