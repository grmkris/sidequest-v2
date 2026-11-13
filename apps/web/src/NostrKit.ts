import {
  decryptNip49,
  type EventTemplate,
  eventIdOf,
  freshNip49,
  freshSecretKey,
  PublicKey,
  publicKeyOf,
  type SecretKey,
  signEvent,
  verifyEvent,
} from '@sidequest/nostr'
import { buildSidequestEvent, profileTemplate, walletLink, walletLinkTypedData } from '@sidequest/nostr/vocabulary'
import { webCrypto } from '@sidequest/protocol'
import { Crypto, Effect, type Option, Schema } from 'effect'
import type { KitSigner, Nip07Provider, SignerFailure } from './Signer.ts'

// The Nostr code of the browser, loaded as one chunk the first time a signer is used (see `Signer.ts`): the two
// signers, and the templates the identity page signs. It imports nothing of the website's own modules but types, so
// the bundler has nothing of the initial bundle to split out and share with it.

/**
 * scrypt's cost for a key made here: `log_n = 16`, NIP-49's common choice. It takes 64 MiB and, in noble's JavaScript,
 * about a second on a laptop and a few on a phone, once when the key is made and once at each unlock; above that a
 * phone's tab may run out of memory. The person's password is the rest of the protection.
 */
export const localLogN = 16

const fail = (reason: SignerFailure) => ({ reason })

/** A NIP-07 extension's signer. The extension is not trusted: its key must be a key, and every event it returns must
 * verify and be exactly the template it was given, signed by that key. */
export const nip07Signer = Effect.fnUntraced(function* (provider: Nip07Provider) {
  const answered = yield* Effect.tryPromise({
    try: () => provider.getPublicKey(),
    catch: () => fail('extensionRefused'),
  })
  const publicKey = yield* Schema.decodeUnknownEffect(PublicKey)(answered).pipe(
    Effect.mapError(() => fail('extensionUntrusted')),
  )
  const expected = (template: EventTemplate) => eventIdOf({ pubkey: publicKey, ...template })
  const signer: KitSigner = {
    kind: 'nip07',
    publicKey,
    signEvent: (template) =>
      Effect.gen(function* () {
        const signed = yield* Effect.tryPromise({
          try: () => provider.signEvent({ ...template, tags: template.tags.map((tag) => [...tag]) }),
          catch: () => fail('extensionRefused'),
        })
        const event = yield* Effect.fromResult(verifyEvent(signed)).pipe(
          Effect.mapError(() => fail('extensionUntrusted')),
        )
        if (event.pubkey !== publicKey || event.id !== expected(template)) {
          return yield* Effect.fail(fail('extensionUntrusted'))
        }
        return event
      }),
  }
  return signer
})

/** The signer of a key held in this closure, and nowhere else. */
const localSigner = (secret: SecretKey): KitSigner => ({
  kind: 'local',
  publicKey: publicKeyOf(secret),
  signEvent: (template) => signEvent(template, secret).pipe(Effect.provideService(Crypto.Crypto, webCrypto)),
})

/** A fresh key and its NIP-49 backup under `password`. Nobody has handled the key in the clear, so the backup says
 * so (`secure`). */
export const createLocalSigner = Effect.fnUntraced(
  function* (password: string) {
    const secret = yield* freshSecretKey
    // Encrypting refuses only a cost outside NIP-49's range, and this one is fixed inside it.
    const ncryptsec = yield* Effect.orDie(freshNip49(secret, password, { logN: localLogN, keySecurity: 'secure' }))
    return { signer: localSigner(secret), ncryptsec }
  },
  Effect.provideService(Crypto.Crypto, webCrypto),
)

/** The signer of the key an `ncryptsec` holds, opened with its password. */
export const openLocalSigner = (ncryptsec: string, password: string) =>
  decryptNip49(ncryptsec, password).pipe(
    Effect.map((opened) => localSigner(opened.secret)),
    Effect.mapError((refused) => fail(refused.reason === 'wrongPassword' ? 'wrongPassword' : 'notABackup')),
  )

/** A kind-0 profile with the person's name. */
export const profileOf = (name: string, createdAt: number): EventTemplate => profileTemplate(name, createdAt)

/** The EIP-712 typed data a wallet signs to link `pubkey`, as `eth_signTypedData_v4` takes it. */
export const walletLinkTypedDataJson = (pubkey: string, issuedAt: number, chainId: number): string =>
  JSON.stringify(walletLinkTypedData(PublicKey.make(pubkey), issuedAt, chainId))

/** The wallet-link event's template from the account, when the wallet signed and its signature; none when the
 * vocabulary would refuse them (a wallet whose signature or account is not what a link carries). */
export const walletLinkOf = (content: {
  readonly address: string
  readonly issuedAt: number
  readonly walletSignature: string
}): Effect.Effect<Option.Option<EventTemplate>> =>
  Schema.decodeUnknownEffect(walletLink.content)(content).pipe(
    Effect.flatMap((decoded) => buildSidequestEvent(walletLink, decoded, { createdAt: decoded.issuedAt })),
    Effect.option,
  )
