import { Crypto, Effect, Result, Schema } from 'effect'
import { freshEntropy } from './Entropy.ts'
import type { EventTemplate, NostrEvent } from './Event.ts'
import { type PublicKey, publicKeyOf, type SecretKey } from './Keys.ts'
import { decryptNip44, encryptNip44, messageKeysOf } from './Nip44.ts'
import { conversationKey, type MessageKeys } from './Nip44Keys.ts'
import { signEvent } from './Sign.ts'

/**
 * Why a room's signer did not sign, encrypt, decrypt or disclose:
 *
 * - `noNip44`: a NIP-07 extension without `nip44.encrypt` and `nip44.decrypt`, which rooms need.
 * - `refused`: the signer said no or failed (an extension's prompt dismissed, say). Nothing is concluded from it.
 * - `untrusted`: the signer answered something that is not what was asked for.
 * - `undecryptable`: the payload does not open with this key; the same answer every time.
 * - `cannotDisclose`: the signer keeps the conversation key to itself, so it cannot give one message's keys away.
 */
export class RoomSignerRefused extends Schema.TaggedError<RoomSignerRefused>()('RoomSignerRefused', {
  reason: Schema.Literals(['noNip44', 'refused', 'untrusted', 'undecryptable', 'cannotDisclose']),
}) {}

/**
 * Whatever signs and decrypts for one member of a room: its key, a NIP-07 extension's, or a gateway agent's. The room
 * code never holds a secret key; it asks this port. `messageKeys` gives one NIP-44 payload's keys for a disclosure
 * (evidence), never the conversation key.
 */
export interface RoomSigner {
  readonly publicKey: PublicKey
  readonly signEvent: (template: EventTemplate) => Effect.Effect<NostrEvent, RoomSignerRefused>
  readonly encrypt: (peer: PublicKey, plaintext: string) => Effect.Effect<string, RoomSignerRefused>
  readonly decrypt: (peer: PublicKey, payload: string) => Effect.Effect<string, RoomSignerRefused>
  readonly messageKeys: (peer: PublicKey, payload: string) => Effect.Effect<MessageKeys, RoomSignerRefused>
}

const refusedAs = (reason: RoomSignerRefused['reason']) => () => new RoomSignerRefused({ reason })

/** The signer of a key this process holds (a key made in the browser, or a gateway agent's), drawing randomness from
 * `crypto`. */
export const localRoomSigner = (secret: SecretKey, crypto: Crypto.Crypto): RoomSigner => {
  const keyWith = (peer: PublicKey) =>
    Effect.fromResult(Result.mapError(conversationKey(secret, peer), refusedAs('undecryptable')))
  return {
    publicKey: publicKeyOf(secret),
    signEvent: (template) => signEvent(template, secret).pipe(Effect.provideService(Crypto.Crypto, crypto)),
    encrypt: (peer, plaintext) =>
      Effect.gen(function* () {
        const key = yield* keyWith(peer)
        const nonce = yield* freshEntropy.pipe(Effect.provideService(Crypto.Crypto, crypto))
        return yield* Effect.fromResult(Result.mapError(encryptNip44(plaintext, key, nonce), refusedAs('refused')))
      }),
    decrypt: (peer, payload) =>
      Effect.flatMap(keyWith(peer), (key) =>
        Effect.fromResult(Result.mapError(decryptNip44(payload, key), refusedAs('undecryptable'))),
      ),
    messageKeys: (peer, payload) =>
      Effect.flatMap(keyWith(peer), (key) =>
        Effect.fromResult(Result.mapError(messageKeysOf(payload, key), refusedAs('undecryptable'))),
      ),
  }
}
