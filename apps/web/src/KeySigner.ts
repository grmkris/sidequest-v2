import { freshNip49, publicKeyOf, type SecretKey, signEvent } from '@sidequest/nostr'
import { localRoomSigner } from '@sidequest/nostr/rooms'
import { webCrypto } from '@sidequest/protocol'
import { Crypto, Effect, Option } from 'effect'
import type { KitSigner } from './Signer.ts'

// The signer of a key the browser holds: one made here, or one a passkey derived. Part of the Nostr chunk
// (`NostrKit.ts`), which loads the first time a signer is used.

/**
 * scrypt's cost for a key's backup made here: `log_n = 16`, NIP-49's common choice. It takes 64 MiB and, in noble's
 * JavaScript, about a second on a laptop and a few on a phone, once when the backup is made and once at each unlock;
 * above that a phone's tab may run out of memory. The person's password is the rest of the protection.
 */
export const localLogN = 16

/** The signer of a key held in this closure, and nowhere else. It holds the key, so it can also open and disclose a
 * room's messages. */
export const keySigner = (kind: 'local' | 'passkey', secret: SecretKey): KitSigner => ({
  kind,
  publicKey: publicKeyOf(secret),
  signEvent: (template) => signEvent(template, secret).pipe(Effect.provideService(Crypto.Crypto, webCrypto)),
  maybeRoomSigner: Option.some(localRoomSigner(secret, webCrypto)),
})

/** The key's NIP-49 backup under `password`. Nobody has handled the key in the clear, so the backup says so
 * (`secure`). */
export const backupOf = (secret: SecretKey, password: string): Effect.Effect<string> =>
  // Encrypting refuses only a cost outside NIP-49's range, and this one is fixed inside it.
  Effect.orDie(freshNip49(secret, password, { logN: localLogN, keySecurity: 'secure' })).pipe(
    Effect.provideService(Crypto.Crypto, webCrypto),
  )
