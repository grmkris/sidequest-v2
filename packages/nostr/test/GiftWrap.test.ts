import { it } from '@effect/vitest'
import { Crypto, Effect, Layer, Result } from 'effect'
import { describe, expect, test } from 'vitest'
import { freshWrapEntropy, giftWrap, type WrapEntropy } from '../src/GiftWrap.ts'
import { publicKeyOf } from '../src/Keys.ts'
import { makeRumor, type Rumor } from '../src/Rumor.ts'
import { unwrapGift } from '../src/Unwrap.ts'
import { alice, bob, entropy, GeneratedSecret, Hex32, nip59Example, secret, WellFormed } from './fixtures.ts'

const fixed: WrapEntropy = {
  wrapKey: secret('4f02eac59266002db5801adc5270700ca69d5b8f761d8732fab2fbf233c90cbd'),
  sealNonce: entropy('01'.repeat(32)),
  wrapNonce: entropy('02'.repeat(32)),
  sealAux: entropy('03'.repeat(32)),
  wrapAux: entropy('04'.repeat(32)),
}
const times = { sealCreatedAt: 1_800_000_000, wrapCreatedAt: 1_799_990_000 }
const note = (content: string) => ({ created_at: 1_800_000_100, kind: 1, tags: [], content })
const refusal = (wrap: unknown, recipient = bob) =>
  Result.match(unwrapGift(wrap, recipient), { onSuccess: () => 'opened', onFailure: (error) => error.reason })

describe('NIP-59 gift wrap', () => {
  test('opens the example in NIP-59 to its rumor, sealed by its author', () => {
    const opened = Result.getOrUndefined(unwrapGift(nip59Example.wrap, bob))
    expect(opened?.rumor).toEqual(nip59Example.rumor)
    expect(opened?.seal.pubkey).toBe(publicKeyOf(alice))
  })

  it.prop(
    'opens what it wrapped, for the recipient only',
    [GeneratedSecret, GeneratedSecret, GeneratedSecret, Hex32, WellFormed],
    ([author, recipient, wrapKey, nonce, content]) => {
      const rumor = makeRumor(note(content), publicKeyOf(secret(author)))
      const entropyOf = { ...fixed, wrapKey: secret(wrapKey), sealNonce: entropy(nonce) }
      const wrap = Result.getOrUndefined(
        giftWrap(rumor, secret(author), publicKeyOf(secret(recipient)), times, entropyOf),
      )
      const opened = Result.getOrUndefined(unwrapGift(wrap, secret(recipient)))
      return opened?.rumor.id === rumor.id && opened.rumor.content === content && refusal(wrap, alice) !== 'opened'
    },
  )

  test('keeps the times it was given and tags only the recipient', () => {
    const wrap = Result.getOrUndefined(
      giftWrap(makeRumor(note('hi'), publicKeyOf(alice)), alice, publicKeyOf(bob), times, fixed),
    )
    expect(wrap?.created_at).toBe(times.wrapCreatedAt)
    expect(wrap?.tags).toEqual([['p', publicKeyOf(bob)]])
    expect(wrap?.pubkey).toBe(publicKeyOf(fixed.wrapKey))
    expect(Result.getOrUndefined(unwrapGift(wrap, bob))?.seal.created_at).toBe(times.sealCreatedAt)
  })

  test('refuses a rumor its sealer did not author, a signed rumor, and a wrap for someone else', () => {
    const forged = giftWrap(makeRumor(note('I agree'), publicKeyOf(bob)), alice, publicKeyOf(bob), times, fixed)
    expect(refusal(Result.getOrUndefined(forged))).toBe('authorMismatch')
    const signed: Rumor = Object.assign(makeRumor(note('signed'), publicKeyOf(alice)), { sig: 'ab'.repeat(64) })
    expect(refusal(Result.getOrUndefined(giftWrap(signed, alice, publicKeyOf(bob), times, fixed)))).toBe('invalidRumor')
    const toAlice = giftWrap(makeRumor(note('hi'), publicKeyOf(bob)), bob, publicKeyOf(alice), times, fixed)
    expect(refusal(Result.getOrUndefined(toAlice))).toBe('notForRecipient')
    expect(refusal({ ...nip59Example.wrap, content: nip59Example.seal.content })).toBe('invalidWrap')
    expect(refusal(nip59Example.seal)).toBe('invalidWrap')
  })

  it.effect('draws all of its randomness from the host’s Crypto service', () =>
    Effect.gen(function* () {
      const drawn = yield* freshWrapEntropy
      expect(
        [drawn.sealNonce, drawn.wrapNonce, drawn.sealAux, drawn.wrapAux].every((bytes) => bytes.length === 32),
      ).toBe(true)
      expect(drawn.wrapKey).toBe('07'.repeat(32))
    }).pipe(
      Effect.provide(
        Layer.succeed(
          Crypto.Crypto,
          Crypto.make({ randomBytes: (size) => new Uint8Array(size).fill(7), digest: () => Effect.die('unused') }),
        ),
      ),
    ),
  )
})
