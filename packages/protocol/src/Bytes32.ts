import { Schema } from 'effect'

/** A 32-byte EVM word in lowercase hex with its `0x` prefix: a payment hash, a transaction hash. */
export const Bytes32 = Schema.String.check(Schema.isPattern(/^0x[0-9a-f]{64}$/))
export type Bytes32 = typeof Bytes32.Type
