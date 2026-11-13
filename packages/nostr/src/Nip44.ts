import { chacha20 } from '@noble/ciphers/chacha.js'
import { equalBytes } from '@noble/ciphers/utils.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { Result } from 'effect'
import { Base64 } from 'effect/encoding'
import { Entropy } from './Entropy.ts'
import { type ConversationKey, type MessageKeys, messageKeys } from './Nip44Keys.ts'
import { Nip44Refused } from './Nip44Refused.ts'
import { pad, unpad } from './Nip44Padding.ts'

const version = 2
const refuse = (reason: Nip44Refused['reason']) => Result.fail(new Nip44Refused({ reason }))

const concat = (...parts: ReadonlyArray<Uint8Array>) => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  parts.reduce((offset, part) => {
    out.set(part, offset)
    return offset + part.length
  }, 0)
  return out
}

const macOf = (keys: MessageKeys, nonce: Uint8Array, ciphertext: Uint8Array) =>
  hmac(sha256, keys.hmacKey, concat(nonce, ciphertext))

// With the `u` flag a surrogate pair is one code point, so this finds only unpaired surrogates, which UTF-8 cannot carry.
const unpairedSurrogate = /[\uD800-\uDFFF]/u

/**
 * NIP-44 v2: pads, encrypts with ChaCha20 and authenticates with HMAC-SHA256 under keys from the nonce. The plaintext
 * is UTF-8, so a string with an unpaired surrogate is refused rather than silently replaced.
 */
export const encryptNip44 = (
  plaintext: string,
  key: ConversationKey,
  nonce: Entropy,
): Result.Result<string, Nip44Refused> => {
  if (unpairedSurrogate.test(plaintext)) return refuse('notWellFormed')
  const bytes = new TextEncoder().encode(plaintext)
  if (bytes.length < 1 || bytes.length > 65_535) return refuse('plaintextLength')
  const keys = messageKeys(key, nonce)
  const ciphertext = chacha20(keys.chachaKey, keys.chachaNonce, pad(bytes))
  return Result.succeed(
    Base64.encode(concat(Uint8Array.of(version), nonce, ciphertext, macOf(keys, nonce, ciphertext))),
  )
}

interface Payload {
  readonly nonce: Entropy
  readonly ciphertext: Uint8Array
  readonly mac: Uint8Array
}

/** Splits a payload into its nonce, ciphertext and MAC, checking its version and the bounds NIP-44 sets. */
const parsePayload = (payload: string): Result.Result<Payload, Nip44Refused> => {
  if (payload.startsWith('#')) return refuse('unknownVersion')
  if (payload.length < 132 || payload.length > 87_472) return refuse('payloadLength')
  return Result.flatMap(
    Result.mapError(Base64.decode(payload), () => new Nip44Refused({ reason: 'badBase64' })),
    (data) => {
      if (data.length < 99 || data.length > 65_603) return refuse('payloadLength')
      if (data[0] !== version) return refuse('unknownVersion')
      // The nonce is 32 bytes by construction.
      const nonce = Entropy.make(data.slice(1, 33))
      return Result.succeed({ nonce, ciphertext: data.subarray(33, -32), mac: data.subarray(-32) })
    },
  )
}

const open = (payload: Payload, keys: MessageKeys): Result.Result<string, Nip44Refused> => {
  if (!equalBytes(macOf(keys, payload.nonce, payload.ciphertext), payload.mac)) return refuse('badMac')
  const plaintext = unpad(chacha20(keys.chachaKey, keys.chachaNonce, payload.ciphertext))
  return plaintext === undefined ? refuse('badPadding') : Result.succeed(new TextDecoder().decode(plaintext))
}

/** Authenticates and decrypts a NIP-44 v2 payload with the conversation key. */
export const decryptNip44 = (payload: string, key: ConversationKey): Result.Result<string, Nip44Refused> =>
  Result.flatMap(parsePayload(payload), (parsed) => open(parsed, messageKeys(key, parsed.nonce)))

/** The keys of one payload, which its sender or recipient can disclose to prove what that one message said. */
export const messageKeysOf = (payload: string, key: ConversationKey): Result.Result<MessageKeys, Nip44Refused> =>
  Result.map(parsePayload(payload), (parsed) => messageKeys(key, parsed.nonce))

/** Authenticates and decrypts one payload with its disclosed message keys, without the conversation key. */
export const openWithMessageKeys = (payload: string, keys: MessageKeys): Result.Result<string, Nip44Refused> =>
  Result.flatMap(parsePayload(payload), (parsed) => open(parsed, keys))
