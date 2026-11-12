import type * as Domain from '@alchemy.run/domain'
import type { Party } from '@sidequest/domain/Actor'
import { unixSeconds } from '@sidequest/domain/Authority'
import { Agent } from '@sidequest/domain/Identity/Agent.aggregate'
import { type AccountId, type AgentId, Forbidden, NotFound, type Unavailable } from '@sidequest/protocol'
import { Context, DateTime, Effect, Layer, Option, Predicate, Schema } from 'effect'
import { AgentTokens, type LiveToken } from './AgentTokens.ts'

type AgentState = Domain.Aggregate.StateOf<typeof Agent>
type Registered = Extract<AgentState, { readonly _tag: 'Registered' }>

/**
 * Why a bearer token does not let an agent in: it is not a live token (unknown, expired or revoked), or the agent it
 * names is gone, revoked, has no grant yet, or its grant has ended.
 */
export const DenialReason = Schema.Literals([
  'unknown_token',
  'unknown_agent',
  'agent_revoked',
  'no_grant',
  'grant_expired',
])
export type DenialReason = typeof DenialReason.Type

export class AccessDenied extends Schema.TaggedError<AccessDenied>()('AccessDenied', { reason: DenialReason }) {}

/** The token of an `Authorization: Bearer <token>` header (RFC 6750; the scheme in any letter case), if any. */
export const bearerOf = (authorization: string | undefined) =>
  Option.flatMapNullishOr(Option.fromNullishOr(authorization), (value) => /^Bearer +(\S+)\s*$/i.exec(value)?.[1])

/** An agent a bearer token let in: who it acts as, with its grant as it stands now, and the token it used. */
export interface AgentCaller {
  readonly actor: Party & { readonly agent: NonNullable<Party['agent']> }
  readonly token: LiveToken
}

/**
 * Who an agent's access token lets in, and which agents a person may issue tokens for. Both read the `Agent`
 * aggregate, which holds the agent's operator and current grant, so a grant changed or revoked a moment ago counts on
 * the very next request; the token itself only names the agent.
 */
export class AgentAccess extends Context.Service<
  AgentAccess,
  {
    /** The agent `account` operates, registered; anyone else's or one never registered is refused. */
    readonly operated: (account: AccountId, agent: AgentId) => Effect.Effect<Registered, Forbidden | NotFound>
    /** The agent a bearer token names, as a party acting for its operator within its current grant. */
    readonly admit: (token: string) => Effect.Effect<AgentCaller, AccessDenied | Unavailable>
  }
>()('Sidequest/AgentAccess') {
  static readonly layer = Layer.effect(
    AgentAccess,
    Effect.gen(function* () {
      const agents = yield* Agent
      const tokens = yield* AgentTokens
      return AgentAccess.of({
        operated: Effect.fn('Sidequest.AgentAccess.operated')(function* (account, agent) {
          const state = yield* agents.state(agent)
          if (!Predicate.isTagged(state, 'Registered'))
            return yield* new NotFound({ reason: 'NotRegistered', evidence: { agent } })
          if (state.operator !== account)
            return yield* new Forbidden({ reason: 'NotPermitted', evidence: { account, required: 'operator' } })
          return state
        }),
        admit: Effect.fn('Sidequest.AgentAccess.admit')(function* (bearer) {
          const now = unixSeconds(yield* DateTime.now)
          const found = yield* tokens.find(bearer, now)
          if (Option.isNone(found)) return yield* new AccessDenied({ reason: 'unknown_token' })
          const token = found.value
          const state = yield* agents.state(token.agent)
          if (!Predicate.isTagged(state, 'Registered')) return yield* new AccessDenied({ reason: 'unknown_agent' })
          if (state.revoked) return yield* new AccessDenied({ reason: 'agent_revoked' })
          const grant = state.grant
          if (grant === undefined) return yield* new AccessDenied({ reason: 'no_grant' })
          if (now >= grant.expiresAt) return yield* new AccessDenied({ reason: 'grant_expired' })
          yield* Effect.annotateCurrentSpan({ 'sidequest.agent': token.agent, 'sidequest.agent_token': token.id })
          const agent = { id: token.agent, scopes: grant.scopes, expiresAt: grant.expiresAt, revoked: false }
          return { actor: { account: state.operator, agent }, token }
        }),
      })
    }),
  )
}
