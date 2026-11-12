import {
  type AccountId,
  type AccountRef,
  SessionView,
  textDigest,
  type Unavailable,
  type UnixSeconds,
  webCrypto,
} from '@sidequest/protocol'
import { Context, Effect, Layer, Option, Redacted, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'
import { stored } from './Stored.ts'

/** How long a session lasts after sign-in. */
export const sessionSeconds = 7 * 24 * 60 * 60

/** A session token: 32 random bytes in hex. Anything else in the cookie names no session. */
const Token = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

/** Random bytes from Web Crypto, in hex. */
export const randomHex = (size: number) => webCrypto.randomBytes(size).pipe(Effect.map(hex), Effect.orDie)

/**
 * The people's sessions in D1. The cookie carries a random token; the table holds only its SHA-256, with the account,
 * the wallet it signed in with, when it ends and whether it was revoked. A token whose session ended, was revoked or
 * never existed finds nothing.
 */
export class Sessions extends Context.Service<
  Sessions,
  {
    readonly open: (
      account: AccountId,
      wallet: AccountRef,
      now: UnixSeconds,
    ) => Effect.Effect<{ readonly token: Redacted.Redacted; readonly session: SessionView }, Unavailable>
    readonly find: (token: string, now: UnixSeconds) => Effect.Effect<Option.Option<SessionView>, Unavailable>
    readonly revoke: (token: string, now: UnixSeconds) => Effect.Effect<void, Unavailable>
  }
>()('Sidequest/Sessions') {
  static readonly layer = Layer.effect(
    Sessions,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const live = SqlSchema.findOneOption({
        Request: Schema.Struct({ tokenHash: Schema.String, now: Schema.Int }),
        Result: SessionView,
        execute: ({ tokenHash, now }) => sql`
          SELECT account, wallet, expires_at AS expiresAt FROM sessions
          WHERE token_hash = ${tokenHash} AND revoked_at IS NULL AND expires_at > ${now}`,
      })
      return Sessions.of({
        open: Effect.fn('Sidequest.Sessions.open')(function* (account, wallet, now) {
          const token = yield* randomHex(32)
          const session = { account, wallet, expiresAt: now + sessionSeconds }
          yield* stored(sql`
            INSERT INTO sessions (token_hash, account, wallet, created_at, expires_at)
            VALUES (${yield* textDigest(token)}, ${account}, ${wallet}, ${now}, ${session.expiresAt})`)
          return { token: Redacted.make(token), session }
        }),
        find: Effect.fn('Sidequest.Sessions.find')(function* (token, now) {
          if (!Schema.is(Token)(token)) return Option.none()
          return yield* stored(live({ tokenHash: yield* textDigest(token), now }))
        }),
        revoke: Effect.fn('Sidequest.Sessions.revoke')(function* (token, now) {
          if (!Schema.is(Token)(token)) return
          yield* stored(sql`
            UPDATE sessions SET revoked_at = ${now} WHERE token_hash = ${yield* textDigest(token)} AND revoked_at IS NULL`)
        }),
      })
    }),
  )
}
