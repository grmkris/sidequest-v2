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
 * body, made within a minute, by `key`; otherwise fails with `refuse(reason)`. Nothing ambient is read. Without a
 * configured key no one may (`Unavailable`). An authorization can be replayed for the same request within its minute,
 * so what it authorises must be idempotent: a ruling, a hide or an unhide is.
 */
export const requireNip98Key = Effect.fnUntraced(function* <E>(
  request: HttpServerRequest,
  key: Option.Option<string>,
  refuse: (reason: string) => E,
) {
  if (Option.isNone(key)) return yield* new Unavailable()
  const header = request.headers['authorization']
  if (header === undefined) return yield* Effect.fail(refuse('missingAuthorization'))
  const body = yield* request.text.pipe(Effect.mapError(() => refuse('unreadableBody')))
  const payloadSha256 = body === '' ? undefined : yield* textDigest(body)
  const verified = verifyHttpAuth(
    header,
    { url: request.originalUrl, method: request.method, ...(payloadSha256 === undefined ? {} : { payloadSha256 }) },
    yield* nowSeconds,
    authWindowSeconds,
  )
  if (Result.isFailure(verified)) return yield* Effect.fail(refuse(verified.failure.reason))
  if (verified.success !== key.value) return yield* Effect.fail(refuse('notTheKey'))
  return verified.success
})

/**
 * Passes when the request carries a NIP-98 authorization for exactly it by the stage's arbitration key
 * (`SIDEQUEST_ARBITRATION_PUBKEY`, in `settings`); see `requireNip98Key`.
 */
export const requireArbitrationKey = (request: HttpServerRequest, { arbitrationPubkey }: ArbitrationSettings) =>
  requireNip98Key(request, arbitrationPubkey, (reason) =>
    reason === 'notTheKey' ? new ArbitrationRefused({ reason: 'notArbitrator' }) : new ArbitrationRefused({ reason }),
  )
