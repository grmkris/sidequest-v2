import { it } from '@effect/vitest'
import { Entropy, finalizeEvent, publicKeyOf, SecretKey, verifyEvent } from '@sidequest/nostr'
import { Effect, Option, Redacted, Result, Schema } from 'effect'
import { describe, expect } from 'vitest'
import * as NostrKit from '../src/NostrKit.ts'
import { makeSigners, type Nip07Provider, storageKeys } from '../src/Signer.ts'

const password = Redacted.make('correct horse')
const template = NostrKit.profileOf('Ada', 1_800_000_000)
const zeros = Schema.decodeSync(Entropy)(new Uint8Array(32))
const extensionKey = Schema.decodeSync(SecretKey)('7f'.repeat(32))
const other = Schema.decodeSync(SecretKey)('6e'.repeat(32))
// The secret of NIP-49's example backup.
const exampleSecret = Schema.decodeSync(SecretKey)('3501454135014541350145413501453fefb02227e449e57cf4d3a3ce05378683')

/** `localStorage` as a map, recording every value ever written. */
const memoryStorage = () => {
  const items = new Map<string, string>()
  const written: Array<string> = []
  const storage: Storage = {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => {
      items.delete(key)
    },
    setItem: (key, value) => {
      written.push(value)
      items.set(key, value)
    },
  }
  return { storage, items, written }
}

/** A browser whose `localStorage` throws on access, as a private window or blocked site data may. */
const refusingStorage = (): Storage => {
  throw new DOMException('The operation is insecure.', 'SecurityError')
}

const signersOver = (storage: Storage | (() => Storage), extension: Option.Option<Nip07Provider> = Option.none()) =>
  makeSigners({
    findExtension: Effect.succeed(extension),
    storage: typeof storage === 'function' ? storage : () => storage,
    kit: Effect.succeed(NostrKit),
  })

describe('a key made in the browser', () => {
  it.effect('is kept only as NIP-49 ciphertext, and only once the backup is confirmed', () =>
    Effect.gen(function* () {
      const { storage, items, written } = memoryStorage()
      const signers = yield* signersOver(storage)
      const created = yield* signers.createLocal(password)
      expect(created.ncryptsec.startsWith('ncryptsec1')).toBe(true)
      expect(items.size).toBe(0)
      expect((yield* Effect.flip(signers.active)).reason).toBe('locked')

      const identity = yield* signers.confirmBackup
      expect(identity).toEqual({ signerKind: 'local', pubkey: created.pubkey })
      expect([...items.keys()].toSorted()).toEqual([storageKeys.identity, storageKeys.ncryptsec].toSorted())
      expect(items.get(storageKeys.ncryptsec)).toBe(created.ncryptsec)
      // Nothing written is a secret key: no 64-hex value but the public key, and no nsec.
      const hexes = written.flatMap((value) => value.match(/[0-9a-f]{64}/gu) ?? [])
      expect(hexes.every((hex) => hex === created.pubkey)).toBe(true)
      expect(written.some((value) => value.includes('nsec1'))).toBe(false)

      const signed = yield* (yield* signers.active).signEvent(template)
      expect(Result.isSuccess(verifyEvent(signed))).toBe(true)
      expect(signed.pubkey).toBe(created.pubkey)
    }),
  )

  it.effect('after a reload, waits locked until its password opens it', () =>
    Effect.gen(function* () {
      const { storage } = memoryStorage()
      const before = yield* signersOver(storage)
      const created = yield* before.createLocal(password)
      yield* before.confirmBackup

      const reloaded = yield* signersOver(storage)
      expect(yield* reloaded.detect).toEqual({
        extension: false,
        maybeRemembered: Option.some({ signerKind: 'local', pubkey: created.pubkey }),
        maybeUnlocked: Option.none(),
      })
      expect((yield* Effect.flip(reloaded.unlockLocal(Redacted.make('wrong horse')))).reason).toBe('wrongPassword')
      expect((yield* Effect.flip(reloaded.active)).reason).toBe('locked')
      expect(yield* reloaded.unlockLocal(password)).toEqual({ signerKind: 'local', pubkey: created.pubkey })
      expect((yield* (yield* reloaded.active).signEvent(template)).pubkey).toBe(created.pubkey)

      yield* reloaded.forget
      expect(yield* reloaded.detect).toMatchObject({ maybeRemembered: Option.none(), maybeUnlocked: Option.none() })
    }),
  )

  it.effect('restores from a backup made elsewhere: the NIP-49 example', () =>
    Effect.gen(function* () {
      const { storage } = memoryStorage()
      const signers = yield* signersOver(storage)
      const example =
        'ncryptsec1qgg9947rlpvqu76pj5ecreduf9jxhselq2nae2kghhvd5g7dgjtcxfqtd67p9m0w57lspw8gsq6yphnm8623nsl8xn9j4jdzz84zm3frztj3z7s35vpzmqf6ksu8r89qk5z2zxfmu5gv8th8wclt0h4p'
      expect((yield* Effect.flip(signers.restoreLocal('nsec1notabackup', password))).reason).toBe('notABackup')
      const restored = yield* signers.restoreLocal(` ${example}\n`, Redacted.make('nostr'))
      expect(restored).toEqual({ signerKind: 'local', pubkey: publicKeyOf(exampleSecret) })
    }),
  )

  it.effect('still signs for the tab when the browser refuses its storage', () =>
    Effect.gen(function* () {
      const signers = yield* signersOver(refusingStorage)
      expect((yield* signers.detect).maybeRemembered).toEqual(Option.none())
      const created = yield* signers.createLocal(password)
      yield* signers.confirmBackup
      expect((yield* (yield* signers.active).signEvent(template)).pubkey).toBe(created.pubkey)
      expect((yield* Effect.flip(signers.unlockLocal(password))).reason).toBe('nothingStored')
    }),
  )
})

/** An extension that answers with its own key, its signature of what it is given, and whatever `tamper` makes of it. */
const extension = (tamper: (event: ReturnType<typeof finalizeEvent>) => unknown = (event) => event): Nip07Provider => ({
  getPublicKey: async () => publicKeyOf(extensionKey),
  signEvent: async (event) =>
    tamper(
      finalizeEvent(
        Schema.decodeUnknownSync(
          Schema.Struct({
            created_at: Schema.Int,
            kind: Schema.Int,
            tags: Schema.Array(Schema.Array(Schema.String)),
            content: Schema.String,
          }),
        )(event),
        extensionKey,
        zeros,
      ),
    ),
})

describe('a NIP-07 extension', () => {
  it.effect('signs through the extension, and remembers only which signer and whose key', () =>
    Effect.gen(function* () {
      const { storage, items } = memoryStorage()
      const signers = yield* signersOver(storage, Option.some(extension()))
      expect((yield* signers.detect).extension).toBe(true)
      expect(yield* signers.connectExtension).toEqual({ signerKind: 'nip07', pubkey: publicKeyOf(extensionKey) })
      expect([...items.keys()]).toEqual([storageKeys.identity])
      const signed = yield* (yield* signers.active).signEvent(template)
      expect(signed.pubkey).toBe(publicKeyOf(extensionKey))
    }),
  )

  it.effect('after a reload, a page signs with the remembered extension again; a local key stays locked', () =>
    Effect.gen(function* () {
      const { storage } = memoryStorage()
      yield* (yield* signersOver(storage, Option.some(extension()))).connectExtension
      const reloaded = yield* signersOver(storage, Option.some(extension()))
      expect((yield* Effect.flip(reloaded.active)).reason).toBe('locked')
      const signed = yield* (yield* reloaded.resume).signEvent(template)
      expect(signed.pubkey).toBe(publicKeyOf(extensionKey))

      const withLocalKey = memoryStorage()
      const before = yield* signersOver(withLocalKey.storage, Option.some(extension()))
      yield* before.createLocal(password)
      yield* before.confirmBackup
      const afterReload = yield* signersOver(withLocalKey.storage, Option.some(extension()))
      expect((yield* Effect.flip(afterReload.resume)).reason).toBe('locked')
      const nothingRemembered = yield* signersOver(memoryStorage().storage, Option.some(extension()))
      expect((yield* Effect.flip(nothingRemembered.resume)).reason).toBe('locked')
    }),
  )

  it.effect('is not trusted: another event, another key or a bad key is refused', () =>
    Effect.gen(function* () {
      const altered = extension((event) =>
        finalizeEvent({ ...event, content: '{"name":"Mallory"}' }, extensionKey, zeros),
      )
      const impostor = extension((event) => finalizeEvent(event, other, zeros))
      const forged = extension((event) => ({ ...event, sig: '00'.repeat(64) }))
      const reasons = yield* Effect.forEach([altered, impostor, forged], (provider) =>
        Effect.gen(function* () {
          const signers = yield* signersOver(memoryStorage().storage, Option.some(provider))
          yield* signers.connectExtension
          return (yield* Effect.flip(Effect.flatMap(signers.active, (signer) => signer.signEvent(template)))).reason
        }),
      )
      expect(reasons).toEqual(['extensionUntrusted', 'extensionUntrusted', 'extensionUntrusted'])

      const badKey = yield* signersOver(
        memoryStorage().storage,
        Option.some({ ...extension(), getPublicKey: async () => 'npub1…' }),
      )
      expect((yield* Effect.flip(badKey.connectExtension)).reason).toBe('extensionUntrusted')
      const refusing = yield* signersOver(
        memoryStorage().storage,
        Option.some({ ...extension(), getPublicKey: () => Promise.reject(new Error('no')) }),
      )
      expect((yield* Effect.flip(refusing.connectExtension)).reason).toBe('extensionRefused')
      const none = yield* signersOver(memoryStorage().storage)
      expect((yield* Effect.flip(none.connectExtension)).reason).toBe('noExtension')
    }),
  )
})
