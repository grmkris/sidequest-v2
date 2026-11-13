import type { UnixSeconds } from '@sidequest/protocol'
import { Effect, Result } from 'effect'
import { type Entropy, freshEntropy } from './Entropy.ts'
import type { NostrEvent, Tag } from './Event.ts'
import { hexOf } from './Hex.ts'
import { type PublicKey, SecretKey } from './Keys.ts'
import { standardKinds } from './Kinds.ts'
import { encryptNip44 } from './Nip44.ts'
import { conversationKey } from './Nip44Keys.ts'
import type { Nip44Refused } from './Nip44Refused.ts'
import type { Rumor } from './Rumor.ts'
import { finalizeEvent } from './Sign.ts'

/** NIP-59 kinds: the author's signed seal, and the one-time key's gift wrap around it. */
export const sealKind = standardKinds.seal
export const giftWrapKind = standardKinds.giftWrap

/**
 * Everything random in one gift wrap. NIP-59 asks for a fresh one-time key per wrap; passing it in keeps building
 * deterministic, and `giftWrapFresh` draws it all from the host's `Crypto` service.
 */
export interface WrapEntropy {
  readonly wrapKey: SecretKey
  readonly sealNonce: Entropy
  readonly wrapNonce: Entropy
  readonly sealAux: Entropy
  readonly wrapAux: Entropy
}

/**
 * When the seal and the wrap say they were made. NIP-59 asks for times tweaked into the past, independently per layer,
 * so they do not reveal the rumor's real time; the caller chooses them.
 */
export interface WrapTimes {
  readonly sealCreatedAt: UnixSeconds
  readonly wrapCreatedAt: UnixSeconds
}

interface Layer {
  readonly kind: number
  readonly tags: ReadonlyArray<Tag>
  readonly inner: unknown
  readonly signer: SecretKey
  readonly createdAt: UnixSeconds
  readonly nonce: Entropy
  readonly aux: Entropy
}

const encryptedLayer = (layer: Layer, recipient: PublicKey): Result.Result<NostrEvent, Nip44Refused> =>
  Result.flatMap(conversationKey(layer.signer, recipient), (key) =>
    Result.map(encryptNip44(JSON.stringify(layer.inner), key, layer.nonce), (content) =>
      finalizeEvent(
        { created_at: layer.createdAt, kind: layer.kind, tags: layer.tags, content },
        layer.signer,
        layer.aux,
      ),
    ),
  )

/** What wrapping a seal draws: the one-time key, the wrap's NIP-44 nonce and its signature's auxiliary randomness. */
export type SealWrapEntropy = Pick<WrapEntropy, 'wrapKey' | 'wrapNonce' | 'wrapAux'>

/**
 * Wraps a signed seal for `recipient` under the one-time key (kind 1059, tagged `p` with the recipient). The seal may
 * come from any signer, an extension's included: only the wrap's own layer needs a key here, and it is a fresh one.
 */
export const wrapSeal = (
  seal: NostrEvent,
  recipient: PublicKey,
  wrapCreatedAt: UnixSeconds,
  entropy: SealWrapEntropy,
): Result.Result<NostrEvent, Nip44Refused> =>
  encryptedLayer(
    {
      kind: giftWrapKind,
      tags: [['p', recipient]],
      inner: seal,
      signer: entropy.wrapKey,
      createdAt: wrapCreatedAt,
      nonce: entropy.wrapNonce,
      aux: entropy.wrapAux,
    },
    recipient,
  )

/**
 * Seals `rumor` from `author` to `recipient` (kind 13, no tags) and wraps the seal under the one-time key (kind 1059,
 * tagged `p` with the recipient). The rumor's author should be `author`'s public key, or `unwrapGift` refuses it.
 */
export const giftWrap = (
  rumor: Rumor,
  author: SecretKey,
  recipient: PublicKey,
  times: WrapTimes,
  entropy: WrapEntropy,
): Result.Result<NostrEvent, Nip44Refused> =>
  Result.flatMap(
    encryptedLayer(
      {
        kind: sealKind,
        tags: [],
        inner: rumor,
        signer: author,
        createdAt: times.sealCreatedAt,
        nonce: entropy.sealNonce,
        aux: entropy.sealAux,
      },
      recipient,
    ),
    (seal) => wrapSeal(seal, recipient, times.wrapCreatedAt, entropy),
  )

/** Fresh entropy for one gift wrap from the host's `Crypto` service. */
export const freshWrapEntropy = Effect.gen(function* () {
  const wrapKey = yield* SecretKey.makeEffect(hexOf(yield* freshEntropy)).pipe(
    // 32 random bytes are a valid scalar except with probability about 2^-128.
    Effect.orDie,
  )
  return {
    wrapKey,
    sealNonce: yield* freshEntropy,
    wrapNonce: yield* freshEntropy,
    sealAux: yield* freshEntropy,
    wrapAux: yield* freshEntropy,
  } satisfies WrapEntropy
})
