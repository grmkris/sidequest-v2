import { Schema } from 'effect'
import { lowerHex } from './Hex.ts'

// The public key's schema alone, without the curve: reading events and naming people needs it, so code that only reads
// them (the website's pages before they sign) does not carry the secp256k1 code that `Keys.ts` signs with.

/** A person or agent on Nostr: a BIP-340 x-only public key as 64 lowercase hex characters (NIP-01 `pubkey`). */
export const PublicKey = lowerHex(32).pipe(Schema.brand('PublicKey'))
export type PublicKey = typeof PublicKey.Type
