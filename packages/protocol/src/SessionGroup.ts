import { Schema } from 'effect'
import { HttpApiEndpoint, HttpApiGroup, HttpApiSecurity } from 'effect/http-api'
import {
  NotSignedIn,
  SessionView,
  SignInChallenge,
  SignInRefused,
  Unavailable,
  WalletAddress,
  WalletSignature,
  sessionCookieName,
} from './SessionApi.ts'

/** The session cookie, as the API reads and sets it (`sessionCookieName`). */
export const SessionCookie = HttpApiSecurity.apiKey({ key: sessionCookieName, in: 'cookie' })

// The `SessionApi` group alone, apart from its schemas and errors in `SessionApi.ts`: a group is a class built by calls,
// which a bundler keeps wherever its module is imported, so a page that needs only the schemas never loads it.

/** Signing in with a wallet: ask for a message to sign, send it back signed, read the session, sign out. */
export class SessionApi extends HttpApiGroup.make('session').add(
  HttpApiEndpoint.post('challenge', '/api/session/challenge', {
    payload: Schema.Struct({ address: WalletAddress }),
    success: SignInChallenge,
    error: Unavailable,
  }),
  HttpApiEndpoint.post('verify', '/api/session/verify', {
    payload: Schema.Struct({ message: Schema.String.check(Schema.isMaxLength(4096)), signature: WalletSignature }),
    success: SessionView,
    error: [SignInRefused, Unavailable],
  }),
  HttpApiEndpoint.get('current', '/api/session', { success: SessionView, error: [NotSignedIn, Unavailable] }),
  HttpApiEndpoint.post('signOut', '/api/session/sign-out', { error: Unavailable }),
) {}
