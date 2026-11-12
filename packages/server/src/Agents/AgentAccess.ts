import type * as Domain from '@alchemy.run/domain'
import type { Party } from '@sidequest/domain/Actor'
import { unixSeconds } from '@sidequest/domain/Authority'
import { Agent } from '@sidequest/domain/Identity/Agent.aggregate'
import { type AccountId, type AgentId, Forbidden, NotFound, type Unavailable } from '@sidequest/protocol'
import { Context, DateTime, Effect, Layer, Option, Predicate, Result, Schema } from 'effect'
import { AgentTokens, type LiveToken } from './AgentTokens.ts'

type AgentState = Domain.Aggregate.StateOf<typeof Agent>
type Registered = Extract<AgentState, { readonly _tag: 'Registered' }>

/**
 * Why a bearer token does not let an agent in: it is not a live token (unknown, expired or revoked, or its OAuth
 * connection was), it was issued over OAuth for another resource than the one it is sent to, or the agent it names is
 * gone, revoked, has no grant yet, or its grant has ended.
 */
export const DenialReason = Schema.Literals([
  'unknown_token',
  'wrong_resource',
  'unknown_agent',
  'agent_revoked',
  'no_grant',
  'grant_expired',
])
export type DenialReason = typeof DenialReason.Type

export class AccessDenied extends Schema.TaggedError<AccessDenied>()('AccessDenied', { reason: DenialReason }) {}

/** The operator and live grant of an agent's state, or why the agent cannot act: gone, revoked, ungranted, expired. */
const grantOf = (state: AgentState, now: number) => {
  if (!Predicate.isTagged(state, 'Registered')) return Result.fail<DenialReason>('unknown_agent')
  if (state.revoked) return Result.fail<DenialReason>('agent_revoked')
  if (state.grant === undefined) return Result.fail<DenialReason>('no_grant')
  if (now >= state.grant.expiresAt) return Result.fail<DenialReason>('grant_expired')
  return Result.succeed({ operator: state.operator, grant: state.grant })
}

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
    /**
     * The agent a bearer token names, as a party acting for its operator within its current grant. `resource` is the
     * URL of the resource the token is sent to: a token issued over OAuth is accepted only there (its audience, RFC
     * 8707), so one issued for `/mcp` is refused by the HTTP API, which passes none.
     */
    readonly admit: (token: string, resource?: string) => Effect.Effect<AgentCaller, AccessDenied | Unavailable>
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
        admit: Effect.fn('Sidequest.AgentAccess.admit')(function* (bearer, resource) {
          const now = unixSeconds(yield* DateTime.now)
          const found = yield* tokens.find(bearer, now)
          if (Option.isNone(found)) return yield* new AccessDenied({ reason: 'unknown_token' })
          const token = found.value
          if (token.resource !== null && token.resource !== resource)
            return yield* new AccessDenied({ reason: 'wrong_resource' })
          const admitted = grantOf(yield* agents.state(token.agent), now)
          if (Result.isFailure(admitted)) return yield* new AccessDenied({ reason: admitted.failure })
          const { operator, grant } = admitted.success
          yield* Effect.annotateCurrentSpan({ 'sidequest.agent': token.agent, 'sidequest.agent_token': token.id })
          const agent = { id: token.agent, scopes: grant.scopes, expiresAt: grant.expiresAt, revoked: false }
          return { actor: { account: operator, agent }, token }
        }),
      })
    }),
  )
}
