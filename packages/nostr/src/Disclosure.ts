import { Effect, Option, Result, Schema } from 'effect'
import { type NostrEvent, NostrEvent as NostrEventSchema } from './Event.ts'
import { eventIdOf } from './EventHash.ts'
import { sealKind } from './GiftWrap.ts'
import { bytesOf, hexOf, lowerHex } from './Hex.ts'
import { openWithMessageKeys } from './Nip44.ts'
import { Rumor } from './Rumor.ts'
import { type RoomMessage, roomMessageOf } from './RoomMessage.ts'
import type { RoomSigner, RoomSignerRefused } from './RoomSigner.ts'
import { verifyEvent } from './Verify.ts'

// Evidence from a room (ADR-0004, decision 6). A member proves what one message said by handing over the seal its
// author signed and that one NIP-44 payload's three keys. Anyone can check it with nothing else: the seal's signature,
// the HMAC under the disclosed key (which ties the keys to this ciphertext), the decryption, the rumor's author against
// the seal's signer, and the rumor's id against its fields. The conversation key never leaves the member, so no other
// message between the same two keys opens with what was disclosed.

/** The disclosure format's name and version. */
export const disclosureScheme = 'sidequest/nip17-seal-keys/v1'

/** One message disclosed: its author's signed seal and the keys of the seal's payload, as hex. */
export const DisclosureBundle = Schema.Struct({
  scheme: Schema.Literal(disclosureScheme),
  seal: NostrEventSchema,
  keys: Schema.Struct({ chachaKey: lowerHex(32), chachaNonce: lowerHex(12), hmacKey: lowerHex(32) }),
})
export type DisclosureBundle = typeof DisclosureBundle.Type

/** Why a bundle proves nothing: not a bundle, a seal that does not verify, keys that are not this payload's, a
 * payload that does not decrypt to a rumor, or a rumor its seal's signer did not write or whose id is not its own. */
export class DisclosureRefused extends Schema.TaggedError<DisclosureRefused>()('DisclosureRefused', {
  reason: Schema.Literals(['malformed', 'badSeal', 'wrongKeys', 'invalidRumor', 'authorMismatch', 'idMismatch']),
}) {}

/** What a verified bundle proves: this key wrote this rumor (at the time it gives), and, for a room message, what it
 * says in which room. */
export interface VerifiedDisclosure {
  readonly author: Rumor['pubkey']
  readonly rumor: Rumor
  readonly maybeMessage: Option.Option<RoomMessage>
}

/** The bundle for one sealed message, with the keys the member's signer derives for that one payload. */
export const discloseSeal = (
  signer: RoomSigner,
  seal: NostrEvent,
): Effect.Effect<DisclosureBundle, RoomSignerRefused> =>
  Effect.map(signer.messageKeys(seal.pubkey, seal.content), (keys) => ({
    scheme: disclosureScheme,
    seal,
    keys: { chachaKey: hexOf(keys.chachaKey), chachaNonce: hexOf(keys.chachaNonce), hmacKey: hexOf(keys.hmacKey) },
  }))

const refuse = (reason: DisclosureRefused['reason']) => Result.fail(new DisclosureRefused({ reason }))
const decodeBundle = Schema.decodeUnknownResult(DisclosureBundle)
const decodeRumor = Schema.decodeUnknownResult(Schema.fromJsonString(Rumor))

const checkedRumor = (plaintext: string, seal: NostrEvent): Result.Result<Rumor, DisclosureRefused> =>
  Result.flatMap(
    Result.mapError(decodeRumor(plaintext), () => new DisclosureRefused({ reason: 'invalidRumor' })),
    (rumor) => {
      if (rumor.pubkey !== seal.pubkey) return refuse('authorMismatch')
      return eventIdOf(rumor) === rumor.id ? Result.succeed(rumor) : refuse('idMismatch')
    },
  )

/**
 * Checks a disclosure with nothing but the bundle: stateless and total, for anyone (the arbitrator) to run. A rumor
 * that is a room message also yields the message as the room layer reads it.
 */
export const verifyDisclosure = (input: unknown): Result.Result<VerifiedDisclosure, DisclosureRefused> =>
  Result.gen(function* () {
    const bundle = yield* Result.mapError(decodeBundle(input), () => new DisclosureRefused({ reason: 'malformed' }))
    const seal = yield* Result.mapError(verifyEvent(bundle.seal), () => new DisclosureRefused({ reason: 'badSeal' }))
    if (seal.kind !== sealKind) return yield* refuse('badSeal')
    const keys = {
      chachaKey: bytesOf(bundle.keys.chachaKey),
      chachaNonce: bytesOf(bundle.keys.chachaNonce),
      hmacKey: bytesOf(bundle.keys.hmacKey),
    }
    const plaintext = yield* Result.mapError(
      openWithMessageKeys(seal.content, keys),
      () => new DisclosureRefused({ reason: 'wrongKeys' }),
    )
    const rumor = yield* checkedRumor(plaintext, seal)
    return { author: rumor.pubkey, rumor, maybeMessage: roomMessageOf(rumor, seal) }
  })
