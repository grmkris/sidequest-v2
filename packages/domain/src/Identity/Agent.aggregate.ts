import * as Domain from '@alchemy.run/domain'
import { AccountId, AgentId } from '@sidequest/protocol'
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

const Registered = Schema.TaggedStruct('Registered', { operator: AccountId, revoked: Schema.Boolean })
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
 * An agent a person operates. Its grant (scopes and expiry) travels with its requests in the `CurrentActor`, so each
 * command judges it on arrival; this aggregate only decides who may change it.
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
    AgentGranted: (state) => state,
    GrantRevoked: (state) => (Predicate.isTagged(state, 'Registered') ? { ...state, revoked: true } : state),
  },
}) {}
