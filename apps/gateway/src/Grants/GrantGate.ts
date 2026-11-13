import type { PublicKey } from '@sidequest/nostr'
import { type AgentGrantView, GrantScope } from '@sidequest/protocol'
import { Clock, Context, Effect, Layer, Option, Schema } from 'effect'
import { Core, type CoreError } from '../Core/Core.ts'
import { GatewaySettings } from '../Settings.ts'

/**
 * Why an agent may not act now. The core's index shows no active grant from the agent's operator to its key
 * (`NoGrant`; a grant another key signed for it counts for nothing), the operator revoked it (`GrantRevoked`), it has
 * ended (`GrantExpired`) or not begun (`GrantNotYet`), or no active grant has the scope the tool needs
 * (`ScopeMissing`).
 */
export const GrantRefusalReason = Schema.Literals([
  'NoGrant',
  'GrantRevoked',
  'GrantExpired',
  'GrantNotYet',
  'ScopeMissing',
])
export type GrantRefusalReason = typeof GrantRefusalReason.Type

export class GrantRefused extends Schema.TaggedError<GrantRefused>()('GrantRefused', {
  reason: GrantRefusalReason,
  scope: Schema.optionalKey(GrantScope),
}) {}

/** The grant an agent acts under for one tool call: the grant event its signatures name in `sq-grant`. */
export interface Admitted {
  readonly agent: PublicKey
  readonly operator: PublicKey
  readonly grant: AgentGrantView
}

/** A cached read of the grants an agent's key received, and when it was read (Unix milliseconds). */
interface Cached {
  readonly readAt: number
  readonly grants: ReadonlyArray<AgentGrantView>
}

/** The grant that lasts longest, ties to the lowest event id: a stable choice among several that fit. */
const longest = (grants: ReadonlyArray<AgentGrantView>): Option.Option<AgentGrantView> =>
  Option.fromNullishOr(
    grants.toSorted((left, right) => right.expiresAt - left.expiresAt || (left.event < right.event ? -1 : 1))[0],
  )

/**
 * The grant gate: an agent acts only while the core's index shows an active grant its operator signed for its key,
 * read from `GET /api/people/:agent` (`operators`: the unrevoked grants it received, each with its status now), and
 * only with a scope that grant names. The read is kept for `grantCacheSeconds` per agent in this isolate's memory, so
 * a revocation stops the agent within that window; every tool call asks again.
 */
export class GrantGate extends Context.Service<
  GrantGate,
  {
    /** The grant `agent` (operated by `operator`) acts under, holding `scope` (`null`: any active grant). */
    readonly admit: (
      agent: PublicKey,
      operator: PublicKey,
      scope: GrantScope | null,
    ) => Effect.Effect<Admitted, GrantRefused | CoreError>
  }
>()('Sidequest/Gateway/GrantGate') {
  /** Needs the core and the gateway's settings (the cache window). */
  static readonly layer = Layer.effect(
    GrantGate,
    Effect.gen(function* () {
      const core = yield* Core
      const { grantCacheSeconds } = yield* GatewaySettings
      const cache = new Map<string, Cached>()

      const grantsTo = Effect.fnUntraced(function* (agent: PublicKey) {
        const now = yield* Clock.currentTimeMillis
        const cached = cache.get(agent)
        if (cached !== undefined && now - cached.readAt < grantCacheSeconds * 1000) return cached.grants
        const person = yield* core.person(agent)
        const grants = Option.match(person, { onNone: () => [], onSome: ({ operators }) => operators })
        cache.set(agent, { readAt: now, grants })
        return grants
      })

      /** Why the operator's grants to this agent do not let it act: a status, or a revocation the operator signed. */
      const whyNot = Effect.fnUntraced(function* (
        agent: PublicKey,
        operator: PublicKey,
        theirs: ReadonlyArray<AgentGrantView>,
      ) {
        if (theirs.some(({ status }) => status === 'notYet')) return new GrantRefused({ reason: 'GrantNotYet' })
        if (theirs.some(({ status }) => status === 'expired')) return new GrantRefused({ reason: 'GrantExpired' })
        // The agent's record omits revoked grants; the operator's record lists the grants they gave, revoked or not.
        const given = yield* core.person(operator)
        const revoked = Option.exists(given, ({ agents }) =>
          agents.some((grant) => grant.agent === agent && grant.status === 'revoked'),
        )
        return new GrantRefused({ reason: revoked ? 'GrantRevoked' : 'NoGrant' })
      })

      return GrantGate.of({
        admit: Effect.fn('Sidequest.Gateway.GrantGate.admit')(function* (agent, operator, scope) {
          const theirs = (yield* grantsTo(agent)).filter(
            (grant) => grant.operator === operator && grant.agent === agent,
          )
          const active = theirs.filter(({ status }) => status === 'active')
          if (active.length === 0) return yield* yield* whyNot(agent, operator, theirs)
          const fitting = scope === null ? active : active.filter(({ scopes }) => scopes.includes(scope))
          const chosen = longest(fitting)
          if (Option.isNone(chosen))
            return yield* new GrantRefused({ reason: 'ScopeMissing', ...(scope === null ? {} : { scope }) })
          return { agent, operator, grant: chosen.value }
        }),
      })
    }),
  )
}
