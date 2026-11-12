import * as Domain from '@alchemy.run/domain'
import { AccountId, AgentId, Grant } from '@sidequest/protocol'
import { Effect, Predicate, Schema } from 'effect'
import { AgentRevoked } from '../AgentRevoked.rejection.ts'
import { asPerson, unixSeconds } from '../Authority.ts'
import { ExpiryNotInFuture } from '../ExpiryNotInFuture.rejection.ts'
import { NotPermitted } from '../NotPermitted.rejection.ts'
import { AlreadyRegistered } from './AlreadyRegistered.rejection.ts'
import { AgentGranted, GrantAgent } from './GrantAgent.command.ts'
import { NotRegistered } from './NotRegistered.rejection.ts'
import { AgentRegistered, RegisterAgent } from './RegisterAgent.command.ts'
import { GrantRevoked, RevokeGrant } from './RevokeGrant.command.ts'

/** A registered agent: who operates it, its current grant (none until the first), and whether it was revoked. */
const Registered = Schema.TaggedStruct('Registered', {
  operator: AccountId,
  grant: Schema.optionalKey(Grant),
  revoked: Schema.Boolean,
})
const AgentState = Schema.Union([Schema.TaggedStruct('Unregistered', {}), Registered])
type AgentState = typeof AgentState.Type

/** The registered agent, if the person sending the command operates it. */
const operated = Effect.fnUntraced(function* (state: AgentState) {
  const account = yield* asPerson()
  if (!Predicate.isTagged(state, 'Registered')) return yield* new NotRegistered()
  if (state.operator !== account) return yield* new NotPermitted({ account, required: 'operator' })
  return state
})

/**
 * An agent a person operates. It holds the agent's current grant, which the server reads when an agent's access token
 * arrives; the grant (scopes and expiry) then travels with the request in the `CurrentActor`, so each command judges it
 * on arrival. This aggregate decides who may change it.
 */
export class Agent extends Domain.Aggregate('Agent', {
  id: AgentId,
  state: AgentState,
  initial: { _tag: 'Unregistered' },
  commands: [RegisterAgent, GrantAgent, RevokeGrant],
  decide: {
    RegisterAgent: Effect.fn(function* (state, command) {
      const operator = yield* asPerson()
      if (Predicate.isTagged(state, 'Registered')) return yield* new AlreadyRegistered()
      return [new AgentRegistered({ operator, name: command.name })]
    }),
    GrantAgent: Effect.fn(function* (state, command, { id, now }) {
      const agent = yield* operated(state)
      if (agent.revoked) return yield* new AgentRevoked({ agent: id })
      const at = unixSeconds(now)
      if (command.grant.expiresAt <= at)
        return yield* new ExpiryNotInFuture({ expiresAt: command.grant.expiresAt, now: at })
      return [new AgentGranted({ grant: command.grant })]
    }),
    RevokeGrant: Effect.fn(function* (state) {
      const agent = yield* operated(state)
      return agent.revoked ? [] : [new GrantRevoked()]
    }),
  },
  evolve: {
    AgentRegistered: (_, event) => Registered.make({ operator: event.operator, revoked: false }),
    AgentGranted: (state, event) =>
      Predicate.isTagged(state, 'Registered') ? { ...state, grant: event.grant } : state,
    GrantRevoked: (state) => (Predicate.isTagged(state, 'Registered') ? { ...state, revoked: true } : state),
  },
}) {}
