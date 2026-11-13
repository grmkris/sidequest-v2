import type { EventTemplate, NostrEvent } from '@sidequest/nostr'
import type { RoomSigner } from '@sidequest/nostr/rooms'
import { Context, Effect, Exit, Layer, Option, Predicate, Redacted, Ref, Schema } from 'effect'
import type * as NostrKit from './NostrKit.ts'
import { findAuthenticator, type PasskeyPort } from './Webauthn.ts'

export type { PasskeyPort } from './Webauthn.ts'

// The person's Nostr signer in the browser (ADR-0003, decision 4; ADR-0005). This module holds no Nostr code: noble and
// `@sidequest/nostr` live in `NostrKit.ts`, which loads the first time a signer is used, so the pages that never sign
// keep their bundle. A key made here exists in two forms only: NIP-49 ciphertext in `localStorage`, and the decrypted
// key inside one signer's closure in this tab's memory. A key a passkey derives exists only in that closure: the
// passkey derives it again whenever a tab needs it, and `localStorage` keeps only which credential to ask for. Neither
// the Model nor any Message ever holds a key.

/** An x-only public key as 64 lowercase hex characters, as events carry it. */
export const PubkeyHex = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))
export type PubkeyHex = typeof PubkeyHex.Type

/** How a person signs: a NIP-07 browser extension, a key made in this browser, or a key a passkey derives (WebAuthn
 * PRF). A remote signer (NIP-46) will be one more. */
export const SignerKind = Schema.Literals(['nip07', 'local', 'passkey'])
export type SignerKind = typeof SignerKind.Type

/** Which signer, and whose key: all `localStorage` keeps besides a local key's ciphertext. */
export const SignerIdentity = Schema.Struct({ signerKind: SignerKind, pubkey: PubkeyHex })
export type SignerIdentity = typeof SignerIdentity.Type

/** A WebAuthn credential's id, base64url as browsers give it. */
export const CredentialId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{16,1366}$/u))

/** What `localStorage` keeps of the signer: which one and whose key, and for a passkey which credential derives it.
 * Never a key. */
const StoredSigner = Schema.Struct({
  signerKind: SignerKind,
  pubkey: PubkeyHex,
  credentialId: Schema.optionalKey(CredentialId),
})

/** A password as the Model holds it while the person types: redacted, so nothing that prints the Model shows it. */
export const Password = Schema.Redacted(Schema.String)
export type Password = typeof Password.Type

/** Why a signer could not be set up or could not sign. */
export const SignerFailure = Schema.Literals([
  'noExtension',
  /** The extension said no, or failed. */
  'extensionRefused',
  /** The extension answered with a key that is not one, or an event that is not what it was asked to sign. */
  'extensionUntrusted',
  /** No signer is unlocked in this tab. */
  'locked',
  'wrongPassword',
  /** The pasted text is not an `ncryptsec` this site can open. */
  'notABackup',
  /** This browser holds no key to unlock, or cannot keep one. */
  'nothingStored',
  /** The signer's code did not load; the next try loads it again. */
  'notLoaded',
  /** This browser offers no passkeys on this page. */
  'passkeyUnavailable',
  /** The browser or the passkey's provider cannot evaluate WebAuthn's PRF extension, so no key can be derived. */
  'passkeyNoPrf',
  /** The person cancelled the passkey prompt, or it timed out. */
  'passkeyCancelled',
  /** The passkey prompt failed for another reason. */
  'passkeyFailed',
  /** The passkey derived a key other than the one this browser remembers. */
  'passkeyOtherKey',
])
export type SignerFailure = typeof SignerFailure.Type

export class SignerFailed extends Schema.TaggedError<SignerFailed>()('SignerFailed', { reason: SignerFailure }) {}

/** One way of signing as one key. Every implementation answers events whose id and signature it checked. Rooms need
 * NIP-44 too: `maybeRoomSigner` is none for an extension without `nip44`. */
export interface Signer {
  readonly kind: SignerKind
  readonly publicKey: PubkeyHex
  readonly signEvent: (template: EventTemplate) => Effect.Effect<NostrEvent, SignerFailed>
  readonly maybeRoomSigner: Option.Option<RoomSigner>
}

/** A signer as the Nostr code makes it, failing with the reason alone; `Signers` wraps it as a {@link Signer}. */
export interface KitSigner {
  readonly kind: SignerKind
  readonly publicKey: string
  readonly signEvent: (template: EventTemplate) => Effect.Effect<NostrEvent, { readonly reason: SignerFailure }>
  readonly maybeRoomSigner: Option.Option<RoomSigner>
}

const failed = (failure: { readonly reason: SignerFailure }) => new SignerFailed({ reason: failure.reason })

/** A kit's signer as a {@link Signer}. */
const signerOf = (kit: KitSigner): Signer => ({
  kind: kit.kind,
  publicKey: kit.publicKey,
  signEvent: (template) => Effect.mapError(kit.signEvent(template), failed),
  maybeRoomSigner: kit.maybeRoomSigner,
})

/** NIP-07's optional NIP-44 methods, which rooms need: encryption and decryption with the extension's key, which the
 * page never sees. */
export interface Nip07Nip44 {
  readonly encrypt: (peer: string, plaintext: string) => Promise<unknown>
  readonly decrypt: (peer: string, ciphertext: string) => Promise<unknown>
}

/** The NIP-07 interface an extension injects as `window.nostr`; nothing it returns is trusted. */
export interface Nip07Provider {
  readonly getPublicKey: () => Promise<unknown>
  readonly signEvent: (event: unknown) => Promise<unknown>
  readonly nip44?: unknown
}

/** What this browser offers when a page asks: an extension, passkeys, a remembered signer, and one unlocked in this
 * tab. */
export interface Detected {
  readonly extension: boolean
  /** Whether the browser has WebAuthn here and does not say it lacks PRF. */
  readonly passkeys: boolean
  readonly maybeRemembered: Option.Option<SignerIdentity>
  readonly maybeUnlocked: Option.Option<SignerIdentity>
}

/** A local key just made: its public key and its backup, waiting for the person to confirm they saved it. */
export interface CreatedKey {
  readonly pubkey: PubkeyHex
  readonly ncryptsec: string
}

/** A key a passkey derived on "Use my passkey", and the key this browser remembers when that is another. */
export interface FoundPasskey {
  readonly pubkey: PubkeyHex
  readonly maybeOther: Option.Option<PubkeyHex>
}

export class Signers extends Context.Service<
  Signers,
  {
    readonly detect: Effect.Effect<Detected>
    /** Use the extension: read its key and remember it. */
    readonly connectExtension: Effect.Effect<SignerIdentity, SignerFailed>
    /** Make a key and its NIP-49 backup. Nothing is kept until `keepCreated`. */
    readonly createLocal: (password: Password) => Effect.Effect<CreatedKey, SignerFailed>
    /** Make a passkey for `rpId` and derive its key. Nothing is kept until `keepCreated`; a passkey that cannot derive
     * fails with `passkeyNoPrf`, and its provider is told it is of no use. */
    readonly createPasskey: (rpId: string) => Effect.Effect<PubkeyHex, SignerFailed>
    /** The NIP-49 backup of the passkey key just made or found, under `password`. Nothing is kept. */
    readonly backUpCreated: (password: Password) => Effect.Effect<CreatedKey, SignerFailed>
    /** Derive the key of a passkey the person picks (any of `rpId`'s, from any device). Nothing is kept until
     * `keepCreated`. */
    readonly findPasskey: (rpId: string) => Effect.Effect<FoundPasskey, SignerFailed>
    /** Keep and use the key just made or found: a local key once its backup is saved, a passkey key with or without
     * one. A passkey key keeps only its credential's id. */
    readonly keepCreated: Effect.Effect<SignerIdentity, SignerFailed>
    /** Drop the key just made or found, unused. */
    readonly dropCreated: Effect.Effect<void>
    /** Open a pasted `ncryptsec` with its password, keep it, and use the key. */
    readonly restoreLocal: (ncryptsec: string, password: Password) => Effect.Effect<SignerIdentity, SignerFailed>
    /** Open the kept ciphertext with its password. */
    readonly unlockLocal: (password: Password) => Effect.Effect<SignerIdentity, SignerFailed>
    /** Derive the remembered passkey's key again with its passkey; fails with `passkeyOtherKey` if it is not the
     * remembered key. */
    readonly unlockPasskey: (rpId: string) => Effect.Effect<SignerIdentity, SignerFailed>
    /** Drop the signer from this tab and this browser. A local key is gone unless its backup is kept elsewhere. */
    readonly forget: Effect.Effect<void>
    /** The signer unlocked in this tab. */
    readonly active: Effect.Effect<Signer, SignerFailed>
    /** What a page signs with: the signer unlocked in this tab, or else the remembered extension, connected again (an
     * extension keeps its own key, so a page asks it again after a reload). A local key stays locked: only its
     * password opens it, on the identity page; a passkey key likewise waits for its passkey there. */
    readonly resume: Effect.Effect<Signer, SignerFailed>
    /** The Nostr code itself, for the templates a page signs. */
    readonly kit: Effect.Effect<typeof NostrKit, SignerFailed>
  }
>()('@sidequest/web/Signers') {}

/** Where the browser keeps the signer: which one and whose key (with a passkey's credential), and a local key's
 * ciphertext. */
export const storageKeys = { identity: 'sidequest.signer', ncryptsec: 'sidequest.signer.ncryptsec' } as const

const decodeIdentity = Schema.decodeUnknownOption(Schema.fromJsonString(SignerIdentity))
const decodeStored = Schema.decodeUnknownOption(Schema.fromJsonString(StoredSigner))
const encodeStored = Schema.encodeSync(Schema.fromJsonString(StoredSigner))

/** The browser's storage, whose every access may throw (private windows, blocked site data): a read that fails finds
 * nothing, and a write that fails is dropped. */
const storeOver = (storage: () => Storage) => ({
  read: (key: string) =>
    Effect.try(() => storage().getItem(key)).pipe(
      Effect.map(Option.fromNullishOr),
      Effect.orElseSucceed(() => Option.none<string>()),
    ),
  // NOTE: a browser that cannot store still signs for this tab's life; the backup the person confirmed is what
  // survives a reload.
  write: (key: string, value: string) => Effect.try(() => storage().setItem(key, value)).pipe(Effect.ignore),
  remove: (key: string) => Effect.try(() => storage().removeItem(key)).pipe(Effect.ignore),
})

const identityOf = (signer: Signer): SignerIdentity => ({ signerKind: signer.kind, pubkey: signer.publicKey })

const required = <A>(found: Option.Option<A>, reason: SignerFailure) =>
  Option.match(found, { onNone: () => Effect.fail(new SignerFailed({ reason })), onSome: Effect.succeed })

/** The signer unlocked in this tab, or else the remembered extension, connected again. */
const resumed = (
  active: Effect.Effect<Signer, SignerFailed>,
  remembered: Effect.Effect<Option.Option<SignerIdentity>>,
  reconnect: Effect.Effect<SignerIdentity, SignerFailed>,
) =>
  active.pipe(
    Effect.catch((locked) =>
      Effect.flatMap(remembered, (identity) =>
        Option.exists(identity, ({ signerKind }) => signerKind === 'nip07')
          ? Effect.andThen(reconnect, active)
          : Effect.fail(locked),
      ),
    ),
  )

/** What a key just made or found waits with until it is kept: a local key's backup, a passkey key's credential and the
 * way to back it up. */
interface Created {
  readonly signer: Signer
  readonly ncryptsec: Option.Option<string>
  readonly credentialId: Option.Option<string>
  readonly backup: Option.Option<(password: string) => Effect.Effect<string>>
}

/** What `localStorage` keeps besides the signer: a local key's ciphertext, a passkey's credential. */
type Kept = Pick<Created, 'ncryptsec' | 'credentialId'>

const keptLocal = (ncryptsec: string): Kept => ({ ncryptsec: Option.some(ncryptsec), credentialId: Option.none() })

/** The passkey half of the signers: making a passkey and deriving its key, finding one, unlocking a remembered one. */
const passkeySigners = (deps: {
  readonly kit: Effect.Effect<typeof NostrKit, SignerFailed>
  readonly findAuthenticator: Effect.Effect<Option.Option<PasskeyPort>>
  readonly created: Ref.Ref<Option.Option<Created>>
  readonly stored: Effect.Effect<Option.Option<typeof StoredSigner.Type>>
  readonly use: (signer: Signer, kept: Kept) => Effect.Effect<SignerIdentity>
}) => {
  const authenticator = Effect.flatMap(deps.findAuthenticator, (found) => required(found, 'passkeyUnavailable'))
  const hold = (found: NostrKit.KitPasskey) =>
    Effect.as(
      Ref.set(
        deps.created,
        Option.some({
          signer: signerOf(found.signer),
          ncryptsec: Option.none(),
          credentialId: Option.some(found.credentialId),
          backup: Option.some(found.backup),
        }),
      ),
      found.signer.publicKey,
    )
  const backupOfCreated = Effect.flatMap(Ref.get(deps.created), (found) =>
    required(
      Option.flatMap(found, (created) =>
        Option.map(created.backup, (backup) => ({ backup, pubkey: created.signer.publicKey })),
      ),
      'nothingStored',
    ),
  )
  const rememberedPasskey = Effect.flatMap(deps.stored, (found) =>
    required(
      Option.flatMap(
        Option.filter(found, (stored) => stored.signerKind === 'passkey'),
        (stored) => Option.map(Option.fromNullishOr(stored.credentialId), (id) => ({ pubkey: stored.pubkey, id })),
      ),
      'nothingStored',
    ),
  )
  return {
    available: Effect.flatMap(deps.findAuthenticator, (found) =>
      Option.match(found, {
        onNone: () => Effect.succeed(false),
        onSome: (port) => Effect.tryPromise(() => port.prfMaybeAvailable()).pipe(Effect.orElseSucceed(() => true)),
      }),
    ),
    createPasskey: (rpId: string) =>
      Effect.gen(function* () {
        const kit = yield* deps.kit
        const port = yield* authenticator
        return yield* hold(yield* Effect.mapError(kit.createPasskeySigner(port, rpId), failed))
      }),
    backUpCreated: (password: Password) =>
      Effect.gen(function* () {
        const created = yield* backupOfCreated
        return { pubkey: created.pubkey, ncryptsec: yield* created.backup(Redacted.value(password)) }
      }),
    findPasskey: (rpId: string) =>
      Effect.gen(function* () {
        const kit = yield* deps.kit
        const port = yield* authenticator
        const pubkey = yield* hold(yield* Effect.mapError(kit.findPasskeySigner(port, rpId, Option.none()), failed))
        const maybeRemembered = Option.map(yield* deps.stored, (stored) => stored.pubkey)
        return { pubkey, maybeOther: Option.filter(maybeRemembered, (other) => other !== pubkey) }
      }),
    unlockPasskey: (rpId: string) =>
      Effect.gen(function* () {
        const remembered = yield* rememberedPasskey
        const kit = yield* deps.kit
        const port = yield* authenticator
        const found = yield* Effect.mapError(kit.findPasskeySigner(port, rpId, Option.some(remembered.id)), failed)
        if (found.signer.publicKey !== remembered.pubkey) return yield* new SignerFailed({ reason: 'passkeyOtherKey' })
        return yield* deps.use(signerOf(found.signer), {
          ncryptsec: Option.none(),
          credentialId: Option.some(found.credentialId),
        })
      }),
  }
}

/** Signs with a signer from now on, and remembers it (with a local key's ciphertext, or a passkey's credential) in
 * this browser. */
const using =
  (tab: {
    readonly active: Ref.Ref<Option.Option<Signer>>
    readonly created: Ref.Ref<Option.Option<Created>>
    readonly store: ReturnType<typeof storeOver>
  }) =>
  (signer: Signer, kept: Kept) =>
    Effect.gen(function* () {
      yield* Ref.set(tab.active, Option.some(signer))
      yield* Ref.set(tab.created, Option.none())
      const credential = Option.match(kept.credentialId, { onNone: () => ({}), onSome: (id) => ({ credentialId: id }) })
      yield* tab.store.write(storageKeys.identity, encodeStored({ ...identityOf(signer), ...credential }))
      yield* Option.match(kept.ncryptsec, {
        onNone: () => tab.store.remove(storageKeys.ncryptsec),
        onSome: (text) => tab.store.write(storageKeys.ncryptsec, text),
      })
      return identityOf(signer)
    })

/** The signers over a way to find the extension and the browser's WebAuthn, the browser's storage and the Nostr code. */
export const makeSigners = (config: {
  readonly findExtension: Effect.Effect<Option.Option<Nip07Provider>>
  readonly findAuthenticator: Effect.Effect<Option.Option<PasskeyPort>>
  readonly storage: () => Storage
  readonly kit: Effect.Effect<typeof NostrKit, SignerFailed>
}) =>
  Effect.gen(function* () {
    const active = yield* Ref.make(Option.none<Signer>())
    const created = yield* Ref.make(Option.none<Created>())
    const store = storeOver(config.storage)
    const use = using({ active, created, store })
    const connectExtension = Effect.gen(function* () {
      const kit = yield* config.kit
      const provider = yield* Effect.flatMap(config.findExtension, (found) => required(found, 'noExtension'))
      const signer = yield* Effect.mapError(kit.nip07Signer(provider), failed)
      return yield* use(signerOf(signer), { ncryptsec: Option.none(), credentialId: Option.none() })
    })
    const activeSigner = Effect.flatMap(Ref.get(active), (found) => required(found, 'locked'))
    const remembered = Effect.map(store.read(storageKeys.identity), Option.flatMap(decodeIdentity))
    const { available, ...passkeys } = passkeySigners({
      kit: config.kit,
      findAuthenticator: config.findAuthenticator,
      created,
      stored: Effect.map(store.read(storageKeys.identity), Option.flatMap(decodeStored)),
      use,
    })
    return Signers.of({
      detect: Effect.gen(function* () {
        return {
          extension: Option.isSome(yield* config.findExtension),
          passkeys: yield* available,
          maybeRemembered: yield* remembered,
          maybeUnlocked: Option.map(yield* Ref.get(active), identityOf),
        }
      }),
      connectExtension,
      createLocal: (password) =>
        Effect.gen(function* () {
          const kit = yield* config.kit
          const made = yield* kit.createLocalSigner(Redacted.value(password))
          yield* Ref.set(
            created,
            Option.some({ signer: signerOf(made.signer), ...keptLocal(made.ncryptsec), backup: Option.none() }),
          )
          return { pubkey: made.signer.publicKey, ncryptsec: made.ncryptsec }
        }),
      keepCreated: Ref.get(created).pipe(
        Effect.flatMap((found) => required(found, 'nothingStored')),
        Effect.flatMap((kept) => use(kept.signer, kept)),
      ),
      dropCreated: Ref.set(created, Option.none()),
      ...passkeys,
      restoreLocal: (ncryptsec, password) =>
        Effect.gen(function* () {
          const kit = yield* config.kit
          const signer = yield* Effect.mapError(kit.openLocalSigner(ncryptsec.trim(), Redacted.value(password)), failed)
          return yield* use(signerOf(signer), keptLocal(ncryptsec.trim()))
        }),
      unlockLocal: (password) =>
        Effect.gen(function* () {
          const stored = yield* Effect.flatMap(store.read(storageKeys.ncryptsec), (found) =>
            required(found, 'nothingStored'),
          )
          const kit = yield* config.kit
          const signer = yield* Effect.mapError(kit.openLocalSigner(stored, Redacted.value(password)), failed)
          return yield* use(signerOf(signer), keptLocal(stored))
        }),
      forget: Effect.gen(function* () {
        yield* Ref.set(active, Option.none())
        yield* Ref.set(created, Option.none())
        yield* store.remove(storageKeys.identity)
        yield* store.remove(storageKeys.ncryptsec)
      }),
      active: activeSigner,
      resume: resumed(activeSigner, remembered, connectExtension),
      kit: config.kit,
    })
  })

const isNip07 = (value: unknown): value is Nip07Provider =>
  Predicate.hasProperty(value, 'getPublicKey') &&
  Predicate.isFunction(value.getPublicKey) &&
  Predicate.hasProperty(value, 'signEvent') &&
  Predicate.isFunction(value.signEvent)

/** The extension injected as `window.nostr`, looked for at each use: extensions may inject after the page loaded. */
const findExtension = (target: Window): Option.Option<Nip07Provider> => {
  const injected: unknown = 'nostr' in target ? target.nostr : undefined
  return isNip07(injected) ? Option.some(injected) : Option.none()
}

export const signersLayer = (target: Window) =>
  Layer.effect(
    Signers,
    Effect.gen(function* () {
      const kit = yield* Effect.cachedWithTTL(
        Effect.tryPromise({
          try: () => import('./NostrKit.ts'),
          catch: () => new SignerFailed({ reason: 'notLoaded' }),
        }),
        (exit) => (Exit.isSuccess(exit) ? 'Infinity' : 0),
      )
      return yield* makeSigners({
        findExtension: Effect.sync(() => findExtension(target)),
        findAuthenticator: Effect.sync(() => findAuthenticator(target)),
        storage: () => target.localStorage,
        kit,
      })
    }),
  )
