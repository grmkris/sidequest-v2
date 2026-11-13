import { it } from '@effect/vitest'
import { webCrypto } from '@sidequest/protocol'
import { Effect, Result, Schema } from 'effect'
import { describe, expect } from 'vitest'
import { type DisclosureBundle, verifyDisclosure } from '../src/Disclosure.ts'
import { EventId, type NostrEvent } from '../src/Event.ts'
import { sealKind } from '../src/GiftWrap.ts'
import { hexOf } from '../src/Hex.ts'
import { publicKeyOf } from '../src/Keys.ts'
import type { PublicKey } from '../src/PublicKey.ts'
import type { RelayUrl } from '../src/RelayList.ts'
import { foundingOf } from '../src/RoomMessage.ts'
import { localRoomSigner, RoomSignerRefused } from '../src/RoomSigner.ts'
import { makeRumor } from '../src/Rumor.ts'
import { finalizeEvent } from '../src/Sign.ts'
import { zeros } from './fixtures.ts'
import { atStart, bidderKey, buyerKey, memberOf, memoryRelays, relayUrl, strangerKey } from './RoomWorld.ts'

const job = Schema.decodeSync(EventId)('ef'.repeat(32))

/** A buyer and a bidder who exchanged two messages; the bidder discloses one of them. */
const exchanged = Effect.gen(function* () {
  yield* atStart
  const network = memoryRelays()
  const directory = new Map<PublicKey, ReadonlyArray<RelayUrl>>()
  const buyer = yield* memberOf(network, directory, buyerKey)
  const bidder = yield* memberOf(network, directory, bidderKey)
  directory.set(buyer.pubkey, [relayUrl('buyer')])
  directory.set(bidder.pubkey, [relayUrl('bidder')])
  const founding = foundingOf(job, buyer.pubkey, bidder.pubkey)
  yield* buyer.rooms.create(founding)
  yield* bidder.rooms.create(founding)
  const promised = yield* buyer.rooms.send(founding.room, { _tag: 'Text', text: 'I will pay 300 on delivery.' })
  const other = yield* buyer.rooms.send(founding.room, { _tag: 'Text', text: 'Something else entirely.' })
  yield* bidder.rooms.poll
  const bundle = yield* bidder.rooms.disclose(founding.room, promised.message.id)
  const otherBundle = yield* bidder.rooms.disclose(founding.room, other.message.id)
  return { buyer, bidder, founding, promised, bundle, otherBundle }
})

const reasonOf = (input: unknown) =>
  Result.match(verifyDisclosure(input), { onSuccess: () => 'verified', onFailure: (refusal) => refusal.reason })

const flipped = (hex: string) => `${hex.slice(0, -1)}${hex.endsWith('0') ? '1' : '0'}`

/** A seal Mallory signs around a rumor that claims someone else wrote it, disclosed with its true keys. */
const forgedBundle = (claimed: PublicKey) =>
  Effect.gen(function* () {
    const mallory = localRoomSigner(strangerKey, webCrypto)
    const rumor = makeRumor({ created_at: 1_800_000_000, kind: 14, tags: [], content: 'I owe you' }, claimed)
    const content = yield* mallory.encrypt(mallory.publicKey, JSON.stringify(rumor))
    const seal = finalizeEvent({ created_at: 1_800_000_000, kind: sealKind, tags: [], content }, strangerKey, zeros)
    const keys = yield* mallory.messageKeys(mallory.publicKey, content)
    return {
      scheme: 'sidequest/nip17-seal-keys/v1',
      seal,
      keys: { chachaKey: hexOf(keys.chachaKey), chachaNonce: hexOf(keys.chachaNonce), hmacKey: hexOf(keys.hmacKey) },
    } satisfies DisclosureBundle
  })

describe('disclosure', () => {
  it.effect('proves one message to anyone holding only the bundle', () =>
    Effect.gen(function* () {
      const { bundle, promised, buyer, founding } = yield* exchanged
      const verified = Result.getOrThrow(verifyDisclosure(JSON.parse(JSON.stringify(bundle))))
      expect(verified.author).toBe(buyer.pubkey)
      expect(verified.rumor.id).toBe(promised.message.id)
      expect(verified.maybeMessage).toMatchObject({
        value: { room: founding.room, act: { _tag: 'Text', text: 'I will pay 300 on delivery.' } },
      })
      // Neither the conversation key nor the other message is in it.
      expect(JSON.stringify(bundle)).not.toContain('Something else')
    }),
  )

  it.effect('refuses every tampered bundle', () =>
    Effect.gen(function* () {
      const { bundle, otherBundle, buyer } = yield* exchanged
      const seal: NostrEvent = bundle.seal
      expect(reasonOf({ ...bundle, scheme: 'other/v0' })).toBe('malformed')
      expect(reasonOf({ ...bundle, seal: { ...seal, sig: flipped(seal.sig) } })).toBe('badSeal')
      expect(reasonOf({ ...bundle, seal: { ...seal, content: otherBundle.seal.content } })).toBe('badSeal')
      expect(reasonOf({ ...bundle, keys: { ...bundle.keys, hmacKey: flipped(bundle.keys.hmacKey) } })).toBe('wrongKeys')
      expect(reasonOf({ ...bundle, keys: { ...bundle.keys, chachaKey: flipped(bundle.keys.chachaKey) } })).not.toBe(
        'verified',
      )
      // The keys of one message do not open another between the same two keys.
      expect(reasonOf({ ...bundle, keys: otherBundle.keys })).toBe('wrongKeys')
      expect(reasonOf({ ...otherBundle, keys: bundle.keys })).toBe('wrongKeys')
      expect(reasonOf(yield* forgedBundle(buyer.pubkey))).toBe('authorMismatch')
    }),
  )

  it.effect('a signer that keeps its conversation key cannot disclose, and says so', () =>
    Effect.gen(function* () {
      yield* atStart
      const network = memoryRelays()
      const directory = new Map<PublicKey, ReadonlyArray<RelayUrl>>()
      const local = localRoomSigner(buyerKey, webCrypto)
      const extensionLike = {
        ...local,
        messageKeys: () => Effect.fail(new RoomSignerRefused({ reason: 'cannotDisclose' })),
      }
      const buyer = yield* memberOf(network, directory, buyerKey, {}, extensionLike)
      directory.set(buyer.pubkey, [relayUrl('buyer')])
      const founding = foundingOf(job, buyer.pubkey, publicKeyOf(bidderKey))
      yield* buyer.rooms.create(founding)
      const sent = yield* buyer.rooms.send(founding.room, { _tag: 'Text', text: 'mine' })
      expect(yield* Effect.flip(buyer.rooms.disclose(founding.room, sent.message.id))).toMatchObject({
        reason: 'signer',
        signer: 'cannotDisclose',
      })
    }),
  )
})
