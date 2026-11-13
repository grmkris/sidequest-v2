import type { Unavailable, UnixSeconds } from '@sidequest/protocol'
import { Context, Effect, Layer } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { stored } from '@sidequest/serving/Stored'

/** A nonce issued for one wallet to sign in to one site, until `expiresAt`. */
export interface IssuedNonce {
  readonly nonce: string
  readonly address: string
  readonly domain: string
  readonly issuedAt: UnixSeconds
  readonly expiresAt: UnixSeconds
}

/**
 * The sign-in nonces in D1. `consume` is one statement that marks the nonce used only where it is still unused and
 * unexpired, for the wallet and site it was issued to: D1 runs statements one at a time, so of any number of
 * concurrent or replayed attempts exactly one consumes it.
 */
export class Nonces extends Context.Service<
  Nonces,
  {
    readonly issue: (nonce: IssuedNonce) => Effect.Effect<void, Unavailable>
    readonly consume: (
      nonce: Omit<IssuedNonce, 'issuedAt' | 'expiresAt'>,
      now: UnixSeconds,
    ) => Effect.Effect<boolean, Unavailable>
  }
>()('Sidequest/Nonces') {
  static readonly layer = Layer.effect(
    Nonces,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      return Nonces.of({
        issue: Effect.fn('Sidequest.Nonces.issue')(function* ({ nonce, address, domain, issuedAt, expiresAt }) {
          // Nonces that expired before this one was issued can no longer sign anyone in.
          yield* stored(sql`DELETE FROM sign_in_nonces WHERE expires_at < ${issuedAt}`)
          yield* stored(sql`
            INSERT INTO sign_in_nonces (nonce, address, domain, issued_at, expires_at)
            VALUES (${nonce}, ${address}, ${domain}, ${issuedAt}, ${expiresAt})`)
        }),
        consume: Effect.fn('Sidequest.Nonces.consume')(function* ({ nonce, address, domain }, now) {
          const consumed = yield* stored(sql`
            UPDATE sign_in_nonces SET consumed_at = ${now}
            WHERE nonce = ${nonce} AND address = ${address} AND domain = ${domain}
              AND consumed_at IS NULL AND expires_at > ${now}
            RETURNING nonce`)
          return consumed.length === 1
        }),
      })
    }),
  )
}
