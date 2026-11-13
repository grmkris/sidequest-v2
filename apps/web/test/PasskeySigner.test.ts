import { it } from '@effect/vitest'
import { passkeyPrfInput, publicKeyOf, secretKeyFromPrf } from '@sidequest/nostr'
import { Effect, Option, Redacted } from 'effect'
import { describe, expect } from 'vitest'
import * as NostrKit from '../src/NostrKit.ts'
import { makeSigners, storageKeys } from '../src/Signer.ts'
import { memoryStorage, passkeyProvider, type ProviderTraits } from './BrowserDoubles.ts'

// A key a passkey derives (ADR-0005), through the signers over a passkey provider double: what is kept (only which
// credential), how the key comes back after a reload or on another device, and every way PRF can be missing.

const rpId = 'sidequest.example'
const template = NostrKit.profileOf('Ada', 1_800_000_000)

/** A browser: its own storage, over a provider that may be another browser's too. */
const browser = (provider: ReturnType<typeof passkeyProvider>, storage = memoryStorage()) =>
  Effect.map(
    makeSigners({
      findExtension: Effect.succeed(Option.none()),
      findAuthenticator: Effect.succeed(Option.some(provider.port)),
      storage: () => storage.storage,
      kit: Effect.succeed(NostrKit),
    }),
    (signers) => ({ signers, ...storage }),
  )

/** The public key the provider's only passkey derives, computed here from its PRF as the spec says. */
const expectedPubkey = (provider: ReturnType<typeof passkeyProvider>) => {
  const [id] = [...provider.secrets.keys()]
  return Option.map(secretKeyFromPrf(provider.prfOf(id ?? '', passkeyPrfInput())), publicKeyOf)
}

const madeWith = (traits: ProviderTraits) =>
  Effect.gen(function* () {
    const provider = passkeyProvider(traits)
    const { signers, items, written } = yield* browser(provider)
    const pubkey = yield* signers.createPasskey(rpId)
    return { provider, signers, items, written, pubkey }
  })

describe('a key a passkey derives', () => {
  it.effect('is the spec’s key of the passkey’s PRF, kept as nothing but its credential, and signs', () =>
    Effect.gen(function* () {
      const { provider, signers, items, written, pubkey } = yield* madeWith({ prfAtCreate: true })
      expect(Option.some(pubkey)).toEqual(expectedPubkey(provider))
      // One prompt: the authenticator evaluated PRF while creating, so no assertion followed.
      expect(provider.requests).toHaveLength(0)
      const options = provider.created[0]?.publicKey
      expect(options?.rp.id).toBe(rpId)
      expect(options?.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' })
      expect(items.size).toBe(0)

      expect(yield* signers.keepCreated).toEqual({ signerKind: 'passkey', pubkey })
      const [credentialId] = [...provider.secrets.keys()]
      expect(JSON.parse(items.get(storageKeys.identity) ?? '')).toEqual({ signerKind: 'passkey', pubkey, credentialId })
      expect(items.has(storageKeys.ncryptsec)).toBe(false)
      const hexes = written.flatMap((value) => value.match(/[0-9a-f]{64}/gu) ?? [])
      expect(hexes.every((hex) => hex === pubkey)).toBe(true)

      const active = yield* signers.active
      expect((yield* active.signEvent(template)).pubkey).toBe(pubkey)
      const room = Option.getOrThrow(active.maybeRoomSigner)
      expect(yield* room.decrypt(room.publicKey, yield* room.encrypt(room.publicKey, 'to myself'))).toBe('to myself')
    }),
  )

  it.effect('asks the new passkey once more where the authenticator enables PRF but evaluates it only on use', () =>
    Effect.gen(function* () {
      const { provider, pubkey } = yield* madeWith({})
      expect(Option.some(pubkey)).toEqual(expectedPubkey(provider))
      expect(provider.requests).toHaveLength(1)
      expect(provider.requests[0]?.publicKey?.allowCredentials).toHaveLength(1)
    }),
  )

  it.effect(
    'comes back after a reload from the remembered passkey, and on another device from any of its passkeys',
    () =>
      Effect.gen(function* () {
        const { provider, signers, pubkey } = yield* madeWith({ prfAtCreate: true })
        yield* signers.keepCreated
        const storage = memoryStorage()
        storage.storage.setItem(
          storageKeys.identity,
          JSON.stringify({ signerKind: 'passkey', pubkey, credentialId: [...provider.secrets.keys()][0] }),
        )
        const reloaded = yield* browser(provider, storage)
        expect((yield* reloaded.signers.detect).maybeRemembered).toEqual(Option.some({ signerKind: 'passkey', pubkey }))
        expect((yield* Effect.flip(reloaded.signers.resume)).reason).toBe('locked')
        expect(yield* reloaded.signers.unlockPasskey(rpId)).toEqual({ signerKind: 'passkey', pubkey })
        expect(provider.requests.at(-1)?.publicKey?.allowCredentials).toHaveLength(1)

        const elsewhere = yield* browser(provider)
        expect(yield* elsewhere.signers.findPasskey(rpId)).toEqual({ pubkey, maybeOther: Option.none() })
        expect(provider.requests.at(-1)?.publicKey?.allowCredentials).toEqual([])
        expect(yield* elsewhere.signers.keepCreated).toEqual({ signerKind: 'passkey', pubkey })
      }),
  )

  it.effect('names the remembered key when the passkey found derives another, and refuses to unlock as it', () =>
    Effect.gen(function* () {
      const provider = passkeyProvider({ prfAtCreate: true })
      const storage = memoryStorage()
      const remembered = publicKeyOf(Option.getOrThrow(secretKeyFromPrf(new Uint8Array(32).fill(7))))
      const { signers } = yield* browser(provider, storage)
      const pubkey = yield* signers.createPasskey(rpId)
      const credentialId = [...provider.secrets.keys()][0]
      storage.storage.setItem(
        storageKeys.identity,
        JSON.stringify({ signerKind: 'passkey', pubkey: remembered, credentialId }),
      )
      expect(yield* signers.findPasskey(rpId)).toEqual({ pubkey, maybeOther: Option.some(remembered) })
      yield* signers.dropCreated
      expect((yield* Effect.flip(signers.keepCreated)).reason).toBe('nothingStored')
      expect((yield* Effect.flip(signers.unlockPasskey(rpId))).reason).toBe('passkeyOtherKey')
    }),
  )

  it.effect('offers a NIP-49 backup of the derived key, which opens to the same key and is never stored', () =>
    Effect.gen(function* () {
      const { signers, items, pubkey } = yield* madeWith({ prfAtCreate: true })
      const backup = yield* signers.backUpCreated(Redacted.make('a long password'))
      expect(backup.pubkey).toBe(pubkey)
      const opened = yield* Effect.mapError(NostrKit.openLocalSigner(backup.ncryptsec, 'a long password'), () => 'x')
      expect(opened.publicKey).toBe(pubkey)
      yield* signers.keepCreated
      expect(items.has(storageKeys.ncryptsec)).toBe(false)
    }),
  )
})

describe('a passkey that cannot derive a key', () => {
  it.effect('is not made where the browser says beforehand it lacks PRF', () =>
    Effect.gen(function* () {
      const provider = passkeyProvider({ saysNoPrf: true })
      const { signers } = yield* browser(provider)
      expect((yield* signers.detect).passkeys).toBe(false)
      expect((yield* Effect.flip(signers.createPasskey(rpId))).reason).toBe('passkeyNoPrf')
      expect(provider.created).toHaveLength(0)
    }),
  )

  it.effect('made by a provider without PRF, is reported to it as of no use, and nothing is kept', () =>
    Effect.gen(function* () {
      const provider = passkeyProvider({ prf: false })
      const { signers, items } = yield* browser(provider)
      expect((yield* signers.detect).passkeys).toBe(true)
      expect((yield* Effect.flip(signers.createPasskey(rpId))).reason).toBe('passkeyNoPrf')
      expect(provider.signalled).toEqual([...provider.secrets.keys()])
      expect((yield* Effect.flip(signers.keepCreated)).reason).toBe('nothingStored')
      expect(items.size).toBe(0)
      expect((yield* Effect.flip(signers.findPasskey(rpId))).reason).toBe('passkeyNoPrf')
    }),
  )

  it.effect('says when the person cancelled, and when the browser has no WebAuthn here', () =>
    Effect.gen(function* () {
      const cancelled = yield* browser(passkeyProvider({ refusal: 'NotAllowedError' }))
      expect((yield* Effect.flip(cancelled.signers.createPasskey(rpId))).reason).toBe('passkeyCancelled')
      const broken = yield* browser(passkeyProvider({ refusal: 'SecurityError' }))
      expect((yield* Effect.flip(broken.signers.findPasskey(rpId))).reason).toBe('passkeyFailed')
      const none = yield* makeSigners({
        findExtension: Effect.succeed(Option.none()),
        findAuthenticator: Effect.succeed(Option.none()),
        storage: () => memoryStorage().storage,
        kit: Effect.succeed(NostrKit),
      })
      expect((yield* none.detect).passkeys).toBe(false)
      expect((yield* Effect.flip(none.createPasskey(rpId))).reason).toBe('passkeyUnavailable')
    }),
  )
})
