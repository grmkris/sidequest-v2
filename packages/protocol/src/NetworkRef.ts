import { Schema } from 'effect'

/** A CAIP-2 chain id: `namespace:reference`, e.g. `eip155:5042002`. */
export const networkPattern = '[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}'

export const NetworkRef = Schema.String.check(Schema.isPattern(new RegExp(`^${networkPattern}$`, 'u'))).pipe(
  Schema.brand('NetworkRef'),
)
export type NetworkRef = typeof NetworkRef.Type
