import { verifyHttpAuth } from '@sidequest/nostr'
import { ArbitrationRefused, textDigest, Unavailable } from '@sidequest/protocol'
import { Effect, Option, Result } from 'effect'
import type { HttpServerRequest } from 'effect/http/HttpServerRequest'
import { nowSeconds } from '../Index/Ingest.ts'
import type { ArbitrationSettings } from './EscrowSettings.ts'

/** How far a NIP-98 authorization's `created_at` may be from now: a minute, NIP-98's own suggestion. */
const authWindowSeconds = 60

/**
 * Passes when the request carries a NIP-98 authorization (`Authorization: Nostr …`) for exactly this URL, method and
 * body, made within a minute, by the stage's arbitration key (`SIDEQUEST_ARBITRATION_PUBKEY`, in `settings`). Nothing
 * ambient is read. Without a configured key no one may ask for a ruling (`Unavailable`).
 */
export const requireArbitrationKey = Effect.fnUntraced(function* (
  request: HttpServerRequest,
  { arbitrationPubkey }: ArbitrationSettings,
) {
  if (Option.isNone(arbitrationPubkey)) return yield* new Unavailable()
  const header = request.headers['authorization']
  if (header === undefined) return yield* new ArbitrationRefused({ reason: 'missingAuthorization' })
  const body = yield* request.text.pipe(Effect.mapError(() => new ArbitrationRefused({ reason: 'unreadableBody' })))
  const payloadSha256 = body === '' ? undefined : yield* textDigest(body)
  const verified = verifyHttpAuth(
    header,
    { url: request.originalUrl, method: request.method, ...(payloadSha256 === undefined ? {} : { payloadSha256 }) },
    yield* nowSeconds,
    authWindowSeconds,
  )
  if (Result.isFailure(verified)) return yield* new ArbitrationRefused({ reason: verified.failure.reason })
  if (verified.success !== arbitrationPubkey.value) return yield* new ArbitrationRefused({ reason: 'notArbitrator' })
})
