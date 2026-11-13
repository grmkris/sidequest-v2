import { EventId, type PublicKey, signEvent } from '@sidequest/nostr'
import { buildSidequestEvent, type KindSpec } from '@sidequest/nostr/vocabulary'
import { type GrantScope, type NetworkRef, webCrypto } from '@sidequest/protocol'
import { nowSeconds } from '@sidequest/serving/Authorize'
import { type Limit, RateLimiter } from '@sidequest/serving/RateLimiter'
import { Context, Crypto, Effect, Option, Predicate, Schema } from 'effect'
import { Core, type CoreError } from '../Core/Core.ts'
import { type Admitted, GrantGate } from '../Grants/GrantGate.ts'
import { AgentKeys } from '../Keys/AgentKeys.ts'
import { Refused } from './Tools.ts'

/** The agent an MCP request's access token let in, its operator, and the origin the request came to. */
export interface Caller {
  readonly agent: PublicKey
  readonly operator: PublicKey
}

/**
 * Who sent the MCP request being served, provided by the bearer middleware before the MCP server sees it. The tool
 * registry is shared by every request, so handlers read the caller from the request; a reference with no caller by
 * default keeps it out of their requirements.
 */
export const McpCaller = Context.Reference<Option.Option<Caller>>('Sidequest/Gateway/McpCaller', {
  defaultValue: Option.none,
})

/** Per agent: 120 tool calls a minute, of which 20 may sign and publish. */
export const agentLimits = {
  calls: { limit: 120, windowSeconds: 60 },
  writes: { limit: 20, windowSeconds: 60 },
} as const satisfies Record<string, Limit>

/** A core error as the tool's refusal, the core's own tag and reason kept. */
export const refusedByCore = (error: CoreError) =>
  Predicate.isTagged(error, 'CoreUnavailable')
    ? new Refused({ reason: 'CoreUnavailable' })
    : new Refused({
        reason: 'CoreRefused',
        core: {
          refusal: error.refusal,
          ...(error.reason === undefined ? {} : { reason: error.reason }),
          ...(error.detail === undefined ? {} : { detail: error.detail }),
        },
      })

const decodeEventId = Schema.decodeUnknownOption(EventId)

/**
 * One tool call as the calling agent: counted against its rate limits (a write against both), then let through the
 * grant gate with the scope the tool needs (`null` for a read). A tool that needs a scope but signs and publishes
 * nothing (reading a room) passes `reads`, and counts as a call only. Every refusal is the tool's typed `Refused`.
 */
export const acting = Effect.fnUntraced(function* (scope: GrantScope | null, reads = false) {
  const caller = Option.getOrUndefined(yield* McpCaller)
  if (caller === undefined) return yield* Effect.die(new Error('An MCP tool ran without an authenticated caller'))
  const limiter = yield* RateLimiter
  const gate = yield* GrantGate
  const limited = (limit: Limit) =>
    limiter.take(`agent:${caller.agent}`, limit).pipe(
      Effect.catchTags({
        RateLimited: ({ retryAfterSeconds }) =>
          Effect.fail(new Refused({ reason: 'RateLimited', detail: `Try again in ${retryAfterSeconds} s.` })),
        Unavailable: () => Effect.fail(new Refused({ reason: 'CoreUnavailable', detail: 'The gateway’s store.' })),
      }),
    )
  yield* limited(agentLimits.calls)
  if (scope !== null && !reads) yield* limited(agentLimits.writes)
  return yield* gate.admit(caller.agent, caller.operator, scope).pipe(
    Effect.catchTags({
      GrantRefused: ({ reason, scope: missing }) =>
        Effect.fail(new Refused({ reason, ...(missing === undefined ? {} : { detail: `Needs ${missing}.` }) })),
      CoreRefused: (error) => Effect.fail(refusedByCore(error)),
      CoreUnavailable: (error) => Effect.fail(refusedByCore(error)),
    }),
  )
})

/**
 * Signs one Sidequest event as the admitted agent, naming its grant in `sq-grant`, and publishes it through the core.
 * The agent's key is opened only for the signature. Answers the event's id.
 */
export const publishAs = Effect.fnUntraced(function* <C>(
  admitted: Admitted,
  spec: KindSpec<C>,
  content: C,
  network?: NetworkRef,
) {
  const keys = yield* AgentKeys
  const core = yield* Core
  const grant = decodeEventId(admitted.grant.event)
  if (Option.isNone(grant)) return yield* new Refused({ reason: 'NoGrant', detail: 'The grant’s id is malformed.' })
  const template = yield* buildSidequestEvent(spec, content, {
    createdAt: yield* nowSeconds,
    grant: grant.value,
    ...(network === undefined ? {} : { network }),
  }).pipe(
    Effect.mapError(({ reason }) => new Refused({ reason: 'CoreRefused', detail: `Not a valid event: ${reason}` })),
  )
  const event = yield* keys
    .withKey(admitted.agent, (key) => signEvent(template, key).pipe(Effect.provideService(Crypto.Crypto, webCrypto)))
    .pipe(
      Effect.catchTags({
        KeyUnsealable: () => Effect.fail(new Refused({ reason: 'KeyUnavailable' })),
        Unavailable: () => Effect.fail(new Refused({ reason: 'CoreUnavailable', detail: 'The gateway’s store.' })),
      }),
    )
  yield* core.publish(event).pipe(Effect.mapError(refusedByCore))
  return { id: event.id, signedBy: admitted.agent, grant: grant.value }
})
