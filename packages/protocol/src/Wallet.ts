import { Schema } from 'effect'

/** An EVM address: `0x` and 20 bytes in hex, in any letter case. */
export const WalletAddress = Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]{40}$/))

/** A wallet's signature in hex: 65 bytes from a key, or whatever a contract account's ERC-1271 check accepts. */
export const WalletSignature = Schema.String.check(Schema.isPattern(/^0x(?:[0-9a-fA-F]{2}){1,4096}$/))
