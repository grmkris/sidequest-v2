import { secp256k1 } from '@noble/curves/secp256k1.js'
import { expand, extract } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { Option, Result, Schema } from 'effect'
import { attempt } from './Attempt.ts'
import type { Entropy } from './Entropy.ts'
import { bytesOf } from './Hex.ts'
import type { PublicKey, SecretKey } from './Keys.ts'
import { Nip44Refused } from './Nip44Refused.ts'

/**
 * The key two parties share for NIP-44 v2: `HKDF-extract(salt = "nip44-v2", IKM = x of ECDH)`. Either side derives
 * the same key from its own secret and the other's public key.
 */
export const ConversationKey = Schema.Uint8Array.check(Schema.isBetweenLength(32, 32)).pipe(
  Schema.brand('ConversationKey'),
)
export type ConversationKey = typeof ConversationKey.Type

/**
 * One message's keys, from the conversation key and the message's nonce. Disclosing them (and not the conversation
 * key) lets a third party decrypt and authenticate that one message as evidence, and no other.
 */
export interface MessageKeys {
  readonly chachaKey: Uint8Array
  readonly chachaNonce: Uint8Array
  readonly hmacKey: Uint8Array
}

const salt = new TextEncoder().encode('nip44-v2')

/** The conversation key between `secret` and `peer`, refusing a peer whose x coordinate is not on the curve. */
export const conversationKey = (secret: SecretKey, peer: PublicKey): Result.Result<ConversationKey, Nip44Refused> =>
  Option.match(
    attempt(() => secp256k1.getSharedSecret(bytesOf(secret), bytesOf(`02${peer}`)).subarray(1, 33)),
    {
      onNone: () => Result.fail(new Nip44Refused({ reason: 'badPublicKey' })),
      // HKDF-extract over SHA-256 is always 32 bytes.
      onSome: (shared) => Result.succeed(ConversationKey.make(extract(sha256, shared, salt))),
    },
  )

/** `HKDF-expand(conversation key, info = nonce, 76)`, split into the ChaCha20 key and nonce and the HMAC key. */
export const messageKeys = (key: ConversationKey, nonce: Entropy): MessageKeys => {
  const keys = expand(sha256, key, nonce, 76)
  return { chachaKey: keys.subarray(0, 32), chachaNonce: keys.subarray(32, 44), hmacKey: keys.subarray(44, 76) }
}
