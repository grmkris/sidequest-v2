import { Predicate, Result, Schema } from 'effect'
import type { NostrEvent } from './Event.ts'
import { eventIdOf } from './EventHash.ts'
import { giftWrapKind, sealKind } from './GiftWrap.ts'
import { publicKeyOf, type SecretKey } from './Keys.ts'
import { decryptNip44 } from './Nip44.ts'
import { conversationKey } from './Nip44Keys.ts'
import { Rumor } from './Rumor.ts'
import { verifyEvent } from './Verify.ts'

/** Why a gift wrap did not open to a rumor its seal's author vouches for. */
export class Nip59Refused extends Schema.TaggedError<Nip59Refused>()('Nip59Refused', {
  reason: Schema.Literals([
    'invalidWrap',
    'notForRecipient',
    'undecryptable',
    'invalidSeal',
    'invalidRumor',
    'authorMismatch',
  ]),
}) {}

/** An opened gift wrap: the rumor, the seal its author signed, and the wrap it came in. */
export interface Unwrapped {
  readonly rumor: Rumor
  readonly seal: NostrEvent
  readonly wrap: NostrEvent
}

const refuse = (reason: Nip59Refused['reason']) => Result.fail(new Nip59Refused({ reason }))
const parseJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))
const decodeRumor = Schema.decodeUnknownResult(Rumor)

/** Decrypts a layer's content to JSON with the recipient's key and the layer signer's public key. */
const openLayer = (layer: NostrEvent, recipient: SecretKey): Result.Result<unknown, Nip59Refused> =>
  conversationKey(recipient, layer.pubkey).pipe(
    Result.flatMap((key) => decryptNip44(layer.content, key)),
    Result.flatMap(parseJson),
    Result.mapError(() => new Nip59Refused({ reason: 'undecryptable' })),
  )

const checkWrap = (wrap: NostrEvent, recipient: SecretKey) => {
  if (wrap.kind !== giftWrapKind) return refuse('invalidWrap')
  const addressed = wrap.tags.some((tag) => tag[0] === 'p' && tag[1] === publicKeyOf(recipient))
  return addressed ? Result.succeed(wrap) : refuse('notForRecipient')
}

const checkSeal = (input: unknown) =>
  Result.flatMap(
    Result.mapError(verifyEvent(input), () => new Nip59Refused({ reason: 'invalidSeal' })),
    (seal) => (seal.kind === sealKind && seal.tags.length === 0 ? Result.succeed(seal) : refuse('invalidSeal')),
  )

/** A rumor must be unsigned, carry the id of its own fields, and be by the seal's author. */
const checkRumor = (input: unknown, seal: NostrEvent) => {
  if (Predicate.hasProperty(input, 'sig')) return refuse('invalidRumor')
  return Result.flatMap(
    Result.mapError(decodeRumor(input), () => new Nip59Refused({ reason: 'invalidRumor' })),
    (rumor) => {
      if (eventIdOf(rumor) !== rumor.id) return refuse('invalidRumor')
      return rumor.pubkey === seal.pubkey ? Result.succeed(rumor) : refuse('authorMismatch')
    },
  )
}

/**
 * Opens a kind-1059 gift wrap addressed to `recipient`: verifies the wrap, decrypts and verifies the kind-13 seal,
 * decrypts the rumor and checks that it is unsigned, carries its own id, and is by the seal's signer. Total.
 */
export const unwrapGift = (input: unknown, recipient: SecretKey): Result.Result<Unwrapped, Nip59Refused> =>
  Result.gen(function* () {
    const wrap = yield* checkWrap(
      yield* Result.mapError(verifyEvent(input), () => new Nip59Refused({ reason: 'invalidWrap' })),
      recipient,
    )
    const seal = yield* checkSeal(yield* openLayer(wrap, recipient))
    const rumor = yield* checkRumor(yield* openLayer(seal, recipient), seal)
    return { rumor, seal, wrap }
  })
