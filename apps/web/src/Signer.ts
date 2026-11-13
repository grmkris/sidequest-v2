import type { EventTemplate, NostrEvent } from '@sidequest/nostr'
import type { RoomSigner } from '@sidequest/nostr/rooms'
import { Context, Effect, Exit, Layer, Option, Predicate, Redacted, Ref, Schema } from 'effect'
import type * as NostrKit from './NostrKit.ts'

// The person's Nostr signer in the browser (ADR-0003, decision 4). This module holds no Nostr code: noble and
// `@sidequest/nostr` live in `NostrKit.ts`, which loads the first time a signer is used, so the pages that never sign
// keep their bundle. A key made here exists in two forms only: NIP-49 ciphertext in `localStorage`, and the decrypted
// key inside one signer's closure in this tab's memory. Neither the Model nor any Message ever holds it.

/** An x-only public key as 64 lowercase hex characters, as events carry it. */
export const PubkeyHex = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))
export type PubkeyHex = typeof PubkeyHex.Type

/** How a person signs: a NIP-07 browser extension, or a key made in this browser. A passkey-derived key (PRF) and a
 * remote signer (NIP-46) will be two more. */
export const SignerKind = Schema.Literals(['nip07', 'local'])
export type SignerKind = typeof SignerKind.Type

/** Which signer, and whose key: all `localStorage` keeps besides a local key's ciphertext. */
export const SignerIdentity = Schema.Struct({ signerKind: SignerKind, pubkey: PubkeyHex })
export type SignerIdentity = typeof SignerIdentity.Type

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

/** What this browser offers when a page asks: an extension, a remembered signer, and one unlocked in this tab. */
export interface Detected {
  readonly extension: boolean
  readonly maybeRemembered: Option.Option<SignerIdentity>
  readonly maybeUnlocked: Option.Option<SignerIdentity>
}

/** A local key just made: its public key and its backup, waiting for the person to confirm they saved it. */
export interface CreatedKey {
  readonly pubkey: PubkeyHex
  readonly ncryptsec: string
}

export class Signers extends Context.Service<
  Signers,
  {
    readonly detect: Effect.Effect<Detected>
    /** Use the extension: read its key and remember it. */
    readonly connectExtension: Effect.Effect<SignerIdentity, SignerFailed>
    /** Make a key and its NIP-49 backup. Nothing is kept until `confirmBackup`. */
    readonly createLocal: (password: Password) => Effect.Effect<CreatedKey, SignerFailed>
    /** The person saved the backup: keep its ciphertext and use the key. */
    readonly confirmBackup: Effect.Effect<SignerIdentity, SignerFailed>
    /** Open a pasted `ncryptsec` with its password, keep it, and use the key. */
    readonly restoreLocal: (ncryptsec: string, password: Password) => Effect.Effect<SignerIdentity, SignerFailed>
    /** Open the kept ciphertext with its password. */
    readonly unlockLocal: (password: Password) => Effect.Effect<SignerIdentity, SignerFailed>
    /** Drop the signer from this tab and this browser. A local key is gone unless its backup is kept elsewhere. */
    readonly forget: Effect.Effect<void>
    /** The signer unlocked in this tab. */
    readonly active: Effect.Effect<Signer, SignerFailed>
    /** What a page signs with: the signer unlocked in this tab, or else the remembered extension, connected again (an
     * extension keeps its own key, so a page asks it again after a reload). A local key stays locked: only its
     * password opens it, on the identity page. */
    readonly resume: Effect.Effect<Signer, SignerFailed>
    /** The Nostr code itself, for the templates a page signs. */
    readonly kit: Effect.Effect<typeof NostrKit, SignerFailed>
  }
>()('@sidequest/web/Signers') {}

/** Where the browser keeps the signer: which one and whose key, and a local key's ciphertext. */
export const storageKeys = { identity: 'sidequest.signer', ncryptsec: 'sidequest.signer.ncryptsec' } as const

const decodeIdentity = Schema.decodeUnknownOption(Schema.fromJsonString(SignerIdentity))
const encodeIdentity = Schema.encodeSync(Schema.fromJsonString(SignerIdentity))

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

/** The signers over a way to find the extension, the browser's storage and the Nostr code. */
export const makeSigners = (config: {
  readonly findExtension: Effect.Effect<Option.Option<Nip07Provider>>
  readonly storage: () => Storage
  readonly kit: Effect.Effect<typeof NostrKit, SignerFailed>
}) =>
  Effect.gen(function* () {
    const active = yield* Ref.make(Option.none<Signer>())
    const pending = yield* Ref.make(Option.none<{ readonly signer: Signer; readonly ncryptsec: string }>())
    const store = storeOver(config.storage)
    /** Signs with `signer` from now on, and remembers it (with a local key's ciphertext) in this browser. */
    const use = (signer: Signer, ncryptsec: Option.Option<string>) =>
      Effect.gen(function* () {
        yield* Ref.set(active, Option.some(signer))
        yield* Ref.set(pending, Option.none())
        yield* store.write(storageKeys.identity, encodeIdentity(identityOf(signer)))
        yield* Option.match(ncryptsec, {
          onNone: () => store.remove(storageKeys.ncryptsec),
          onSome: (text) => store.write(storageKeys.ncryptsec, text),
        })
        return identityOf(signer)
      })
    const connectExtension = Effect.gen(function* () {
      const kit = yield* config.kit
      const provider = yield* Effect.flatMap(config.findExtension, (found) => required(found, 'noExtension'))
      const signer = yield* Effect.mapError(kit.nip07Signer(provider), failed)
      return yield* use(signerOf(signer), Option.none())
    })
    const activeSigner = Effect.flatMap(Ref.get(active), (found) => required(found, 'locked'))
    const remembered = Effect.map(store.read(storageKeys.identity), Option.flatMap(decodeIdentity))
    return Signers.of({
      detect: Effect.gen(function* () {
        return {
          extension: Option.isSome(yield* config.findExtension),
          maybeRemembered: yield* remembered,
          maybeUnlocked: Option.map(yield* Ref.get(active), identityOf),
        }
      }),
      connectExtension,
      createLocal: (password) =>
        Effect.gen(function* () {
          const kit = yield* config.kit
          const created = yield* kit.createLocalSigner(Redacted.value(password))
          yield* Ref.set(pending, Option.some({ signer: signerOf(created.signer), ncryptsec: created.ncryptsec }))
          return { pubkey: created.signer.publicKey, ncryptsec: created.ncryptsec }
        }),
      confirmBackup: Ref.get(pending).pipe(
        Effect.flatMap((found) => required(found, 'nothingStored')),
        Effect.flatMap((created) => use(created.signer, Option.some(created.ncryptsec))),
      ),
      restoreLocal: (ncryptsec, password) =>
        Effect.gen(function* () {
          const kit = yield* config.kit
          const signer = yield* Effect.mapError(kit.openLocalSigner(ncryptsec.trim(), Redacted.value(password)), failed)
          return yield* use(signerOf(signer), Option.some(ncryptsec.trim()))
        }),
      unlockLocal: (password) =>
        Effect.gen(function* () {
          const stored = yield* Effect.flatMap(store.read(storageKeys.ncryptsec), (found) =>
            required(found, 'nothingStored'),
          )
          const kit = yield* config.kit
          const signer = yield* Effect.mapError(kit.openLocalSigner(stored, Redacted.value(password)), failed)
          return yield* use(signerOf(signer), Option.some(stored))
        }),
      forget: Effect.gen(function* () {
        yield* Ref.set(active, Option.none())
        yield* Ref.set(pending, Option.none())
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
        storage: () => target.localStorage,
        kit,
      })
    }),
  )
