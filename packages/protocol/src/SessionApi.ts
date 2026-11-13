import { Schema } from 'effect'
import { AccountRef } from './AccountRef.ts'
import { AccountId } from './Id.ts'
import { UnixSeconds } from './UnixSeconds.ts'

/**
 * The session cookie. `__Host-` makes browsers accept it only `Secure`, for `Path=/` and without a `Domain`, so it
 * belongs to the one origin that set it.
 */
export const sessionCookieName = '__Host-sidequest-session'

/** An EVM address: `0x` and 20 bytes in hex, in any letter case. */
export const WalletAddress = Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]{40}$/))

/** A wallet's signature in hex: 65 bytes from a key, or whatever a contract account's ERC-1271 check accepts. */
export const WalletSignature = Schema.String.check(Schema.isPattern(/^0x(?:[0-9a-fA-F]{2}){1,4096}$/))

/** What a wallet signs to sign in: an EIP-4361 (SIWE) message the server wrote, valid until `expiresAt`. */
export const SignInChallenge = Schema.Struct({ message: Schema.String, expiresAt: UnixSeconds })
export type SignInChallenge = typeof SignInChallenge.Type

/** The person a session is for: their account, the wallet they signed in with, and when the session ends. */
export const SessionView = Schema.Struct({ account: AccountId, wallet: AccountRef, expiresAt: UnixSeconds })
export type SessionView = typeof SessionView.Type

/**
 * Why a signed message did not sign anyone in: it is not a SIWE message for this site (`malformed`, `wrong_domain`,
 * `wrong_uri`, `wrong_chain`), it is outside its time (`issued_in_future`, `stale`, `not_yet_valid`, `expired`), its
 * nonce was not issued for this wallet or was used already (`unknown_nonce`), or the wallet did not sign it
 * (`bad_signature`).
 */
export const SignInRefusal = Schema.Literals([
  'malformed',
  'wrong_domain',
  'wrong_uri',
  'wrong_chain',
  'issued_in_future',
  'stale',
  'not_yet_valid',
  'expired',
  'unknown_nonce',
  'bad_signature',
])
export type SignInRefusal = typeof SignInRefusal.Type

export class SignInRefused extends Schema.TaggedError<SignInRefused>()(
  'SignInRefused',
  { reason: SignInRefusal },
  { httpApiStatus: 401 },
) {}

/** The request carries no session the server holds: none, ended, or signed out. */
export class NotSignedIn extends Schema.TaggedError<NotSignedIn>()('NotSignedIn', {}, { httpApiStatus: 401 }) {}

/** Something the server depends on (its database, the chain) did not answer; the request may be retried. */
export class Unavailable extends Schema.TaggedError<Unavailable>()('Unavailable', {}, { httpApiStatus: 503 }) {}
